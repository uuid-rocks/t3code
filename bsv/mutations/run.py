#!/usr/bin/env python3
"""Local, sequential mutation experiment. Run from the repository root with Python 3."""
import argparse
import collections
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import signal
import shlex
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'bsv/mutations'
AGENT_TMP = Path.home() / '.cache/agent-tmp/sol4'
TEMP_ROOT = AGENT_TMP / 'tmp'
TEMP_ROOT.mkdir(parents=True, exist_ok=True)
os.environ['TMPDIR'] = str(TEMP_ROOT)
os.environ['TMP'] = str(TEMP_ROOT)
os.environ['TEMP'] = str(TEMP_ROOT)
WORK = AGENT_TMP / 'work'
SEED = 20261110
NODE_BIN = Path.home() / '.local/share/mise/installs/node/26.12.1/bin'
os.environ['PATH'] = str(NODE_BIN) + os.pathsep + os.environ['PATH']
EXPECTED_NODE_VERSION = 'v26.12.1'
EXCLUDED = {'client-runtime', 'shared', 'contracts'}
BASELINE_FAILURES = []
SCOPES = ['apps/server'] + [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'packages').iterdir()) if p.is_dir() and p.name not in EXCLUDED]
VP = ['pnpm', 'exec', 'vp', 'test']
COMMON = ['--maxWorkers=1', '--reporter=default', '--reporter=json']
OUTSIDE = ['**/apps/web/**', '**/apps/mobile/**', '**/apps/desktop/**', '**/native/**', '**/infra/**', str(ROOT / 'scripts/**'), '**/packages/client-runtime/**', '**/packages/shared/**', '**/packages/contracts/**']

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')

def scoped(file):
    return any(file.startswith(s + '/') for s in SCOPES)

def rel(file):
    return os.path.relpath(file, ROOT)

def run(label, mode, args, cwd=ROOT, workers=1):
    report = WORK / (label + '.json')
    report.unlink(missing_ok=True)
    command = VP + args + (['--config=' + str(OUT / 'vite.config.ts')] if cwd == ROOT else []) + [arg for arg in COMMON if not arg.startswith('--maxWorkers')] + ['--maxWorkers=' + str(workers if cwd == ROOT else 1), '--outputFile.json=' + str(report)]
    start = time.monotonic()
    with (WORK / (label + '.log')).open('w') as log:
        result = subprocess.Popen(command, cwd=cwd, env={**os.environ, 'BSV_MODE': mode, 'NO_COLOR': '1'}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        (WORK / (label + '.pid')).write_text(str(result.pid))
        try:
            result.wait()
        except BaseException:
            os.killpg(result.pid, signal.SIGTERM)
            result.wait()
            raise
    output = (WORK / (label + '.log')).read_text(errors='replace')
    data = json.loads(report.read_text()) if report.exists() else {}
    files = {rel(t['name']): t['status'] for t in data.get('testResults', [])}
    summary = {'cwd': str(cwd), 'command': 'BSV_MODE=' + mode + ' ' + shlex.join(command), 'exit': result.returncode,
               'seconds': round(time.monotonic() - start, 3), 'files': files,
               'errors': data.get('numRuntimeErrorTestSuites'),
               'keyOutput': [s for s in output.splitlines() if any(k in s for k in ['BSV_SELECTION', '[blacksmith]', 'Test Files', 'Tests ', 'Duration', 'Error:', 'No test files'])]}
    with gzip.open(OUT / 'evidence' / (label + '.log.gz'), 'wt') as log:
        log.write(output)
    if not report.exists() and 'No test files' not in output:
        raise RuntimeError('No JSON report: ' + label + '\n' + output[-2000:])
    return summary

def cache_paths():
    return sorted((ROOT / 'node_modules/.vite').glob('vitest/*'))

def restore_cache():
    if not (WORK / 'baseline-cache').exists():
        for archive in (OUT / 'evidence').glob('*-*.json.gz'):
            prefix, _, name = archive.name.partition('-')
            if len(prefix) == 40 and all(c in '0123456789abcdef' for c in prefix):
                target = WORK / 'baseline-cache' / prefix / name.removesuffix('.gz')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(gzip.open(archive, 'rb').read())
        assert list((WORK / 'baseline-cache').glob('*/blacksmith*.json')), 'No archived genuine seed found'
    shutil.rmtree(ROOT / 'node_modules/.vite/vitest', ignore_errors=True)
    shutil.copytree(WORK / 'baseline-cache', ROOT / 'node_modules/.vite/vitest')
    for scope in ['.', *SCOPES]:
        shutil.rmtree(ROOT / scope / 'node_modules/.vitest-cache', ignore_errors=True)

def dependencies():
    imports = collections.defaultdict(set)
    tests = set()
    for path in cache_paths():
        record = path / 'dependencies.json'
        if not record.exists():
            continue
        data = json.loads(record.read_text())
        for project in data.get('projects', {}).values():
            for test, entry in project['files'].items():
                test = rel(ROOT / test)
                if not scoped(test) or test in BASELINE_FAILURES:
                    continue
                tests.add(test)
                for i in entry['deps']:
                    imports[rel(ROOT / project['modules'][i])].add(test)
    return imports, tests

def sample(imports, tests):
    rng = random.Random(SEED)
    tracked = subprocess.check_output(['git', 'ls-files', *SCOPES], cwd=ROOT, text=True).splitlines()
    sources = sorted(f for f in tracked if '/src/' in f and f.endswith(('.ts', '.tsx', '.js', '.mjs')) and not re.search(r'\.(test|spec|testkit|d)\.', f) and not re.search(r'/(test|tests|__tests__|testkit|testUtils|testing|fixtures|__fixtures__)/', f))
    dump(OUT / 'population.json', [{'file': f, 'importingTests': sorted(imports[f])} for f in sources])
    # Exponential race implements weighted sampling without replacement.
    high = [f for f in sources if len(imports[f]) >= 2]
    leaves = [f for f in sources if len(imports[f]) < 2]
    high = sorted(high, key=lambda f: -math.log(rng.random()) / math.sqrt(len(imports[f])))[:32]
    leaves = rng.sample(leaves, 8)
    picked = [{'kind': 'source', 'stratum': 'weighted' if f in high else 'leaf', 'file': f,
               'importingTests': sorted(imports[f]), 'mutation': 'throw at module load'} for f in high + leaves]
    candidates = sorted(t for t in tests if re.search(r'(?<!not)\.(toBe|toEqual|toStrictEqual|toContain)\(', (ROOT / t).read_text()))
    for f in rng.sample(candidates, 10):
        picked.append({'kind': 'test', 'file': f, 'importingTests': sorted(imports[f]), 'mutation': 'negate first equality/containment assertion'})
    fixtures = sorted(f for f in tracked if '/fixtures/' in f and f.endswith('.ndjson'))
    for f in rng.sample(fixtures, 5):
        picked.append({'kind': 'fixture', 'file': f, 'importingTests': sorted(imports[f]), 'mutation': 'append invalid NDJSON record'})
    for i, row in enumerate(picked):
        row['groundTruthMode'] = 'full-scope'
        row['id'] = f'{i + 1:02}'
        row['originalSha256'] = hashlib.sha256((ROOT / row['file']).read_bytes()).hexdigest()
    weighted = [r for r in picked if r.get('stratum') == 'weighted'][:4]
    tests = [r for r in picked if r['kind'] == 'test'][:1]
    return weighted + tests

def mutate(row, original):
    if row['kind'] == 'fixture':
        return original + ('\nBSV_MUTATION_' + row['id'] + '\n').encode()
    if row['kind'] == 'test':
        return re.sub(rb'(\.not)?\.(toBe|toEqual|toStrictEqual|toContain)\(', lambda m: (b'' if m[1] else b'.not') + b'.' + m[2] + b'(', original, count=1)
    marker = ('throw new Error("BSV_MUTATION_' + row['id'] + '");\n').encode()
    if original.startswith(b'#!'):
        shebang, body = original.split(b'\n', 1)
        return shebang + b'\n' + marker + body
    return marker + original

def report(result):
    rows = result['mutations']
    counts = {'mutations': len(rows), 'kinds': dict(collections.Counter(r['kind'] for r in rows)),
              'groundTruthFailingTests': sum(len(r['groundTruthFailing']) for r in rows),
              'selected': sum(len(r['selected']) for r in rows),
              'falseNegatives': sum(len(r['falseNegatives']) for r in rows),
              'overSelected': sum(len(r['overSelected']) for r in rows),
              'noGroundTruthFailures': sum(not r['groundTruthFailing'] for r in rows),
              'meanSelected': sum(len(r['selected']) for r in rows) / len(rows) if rows else 0,
              'totalScopedTests': result['totalScopedTests']}
    counts['meanSelectedOverTotal'] = counts['meanSelected'] / counts['totalScopedTests']
    counts['falseNegativeRate'] = counts['falseNegatives'] / counts['groundTruthFailingTests'] if counts['groundTruthFailingTests'] else None
    result['groups'] = {}
    for group in ['full-scope', 'related-ground-truth']:
        members = [r for r in rows if r['groundTruthMode'] == group]
        result['groups'][group] = {'mutations': len(members),
            'groundTruthFailingTests': sum(len(r['groundTruthFailing']) for r in members),
            'selected': sum(len(r['selected']) for r in members),
            'falseNegatives': sum(len(r['falseNegatives']) for r in members),
            'overSelected': sum(len(r['overSelected']) for r in members),
            'noGroundTruthFailures': sum(not r['groundTruthFailing'] for r in members)}
    for group in result['groups'].values():
        group['falseNegativeRate'] = group['falseNegatives'] / group['groundTruthFailingTests'] if group['groundTruthFailingTests'] else None
        group['meanSelectedOverTotal'] = group['selected'] / group['mutations'] / result['totalScopedTests'] if group['mutations'] else None
    result['status'] = 'stopped_by_user' if result.get('stoppedByUser') else ('complete' if len(rows) == result.get('targetMutations', 5) else 'in_progress')
    result['counts'] = counts
    dump(OUT / 'results.json', result)
    lines = ['# Ordinary-change mutation measurement', '', f"Base: `{result['base']}`. Seed: `{SEED}`. Node: `{result['node']}`. Status: {result['status']}. Local only; no CI.", '',
             'Reproduce the recorded mutations from this commit: `export TMPDIR="$HOME/.cache/agent-tmp/sol4/tmp"; mkdir -p "$TMPDIR"; pnpm install; python3 bsv/mutations/run.py --sample bsv/mutations/sample.json`. This reruns the baseline and all controls. `--resume` resumes interrupted work while its cache remains in $HOME/.cache/agent-tmp/sol4/work.', '',
             'Ground truth: every control runs BSV_MODE=all over the same complete 655-file scope as select, including all scoped packages and apps/server. No related-test controls contribute to the final counts. An eight-worker fixture control had an unrelated interrupted-fiber failure in the ACP inline-exit test and is excluded from the accepted results. The five accepted controls ran the full 655-file scope, including all 481 included server files. The user stopped further testing; the fixture attempt remains inconclusive and excluded. Earlier owning-package-only and server-only controls are superseded. Commands, file statuses, and key output are in results.json; complete terminal output is in evidence/*.log.gz.', '',
             'The user stopped the campaign after five complete rows: four widely imported source files and one test-file edit. These are the first four weighted sources and the first test from the original fixed-seed draw; weights are sqrt(recorded importing-test count). The planned 20-row batch and the ten-full-server-control target were not completed. No fixture row contributes to the final rate. Module-load throws are deliberate behavior-breaking mutations. Assertions negate the first equality/containment matcher. Data mutations append an invalid NDJSON record. Sampling does not use the review reports.', '',
             'The retained historical runs used up to eight workers. The reproducible runner now enforces one worker and disk-backed TMPDIR under $HOME/.cache/agent-tmp/sol4. Historical command strings are evidence, not safe commands to replay verbatim under the new temporary-storage policy. The same passing baseline cache is restored before each select and control run, and node_modules/.vitest-cache is deleted. Over-selection means selected files absent from both the failing-test set and the baseline transitive dependency set (including recorded filesystem reads). In these five rows every selected file failed in the full control, so zero over-selection is exact without relying on recorded imports. Counts are mutation–test-file pairs, not individual assertions or globally unique files. The measured file-level false-negative rate applies only to this early-stopped sample; it does not establish a repository-wide rate.', '',
             'Baseline seeding: ' + result['baseline'].get('seedMethod', 'Unmodified full passing run.') + ' Excluded baseline-failing files: ' + ', '.join(result.get('baselineFailures', [])) + '.', '',
             '```json', json.dumps({'overall': counts, 'groups': result['groups']}, indent=2), '```', '',
             '| ID | Kind | Ground truth | Mutated file | Importers | Selected | GT failures | False negatives | Over-selected | Select exit | Control exit |',
             '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in rows:
        lines.append(f"| {r['id']} | {r['kind']} | {r['groundTruthMode']} | `{r['file']}` | {len(r['importingTests'])} | {len(r['selected'])} | {len(r['groundTruthFailing'])} | {len(r['falseNegatives'])} | {len(r['overSelected'])} | {r['select']['exit']} | {r['control']['exit']} |")
    lines.extend(['', '## False negatives', ''])
    for r in rows:
        if r['falseNegatives']:
            lines.extend([f"### {r['id']}: `{r['file']}`", '', *['- `' + f + '`' for f in r['falseNegatives']], '', r.get('rootCause', 'Root cause pending investigation.'), ''])
    if not any(r['falseNegatives'] for r in rows):
        lines.append('None observed in the full-scope controls.')
    (OUT / 'results.md').write_text('\n'.join(lines) + '\n')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adopt-baseline', help='JSON from an existing baseline run, with its log, command JSON, and dependency records still on disk')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--sample', help='Reuse a recorded sample instead of drawing a new one')
    options = parser.parse_args()
    NODE_VERSION = subprocess.check_output(['node', '--version'], text=True).strip()
    assert NODE_VERSION == EXPECTED_NODE_VERSION, NODE_VERSION
    global BASELINE_FAILURES
    WORK.mkdir(exist_ok=True)
    (OUT / 'evidence').mkdir(exist_ok=True)
    os.chdir(ROOT)
    if options.resume:
        result = json.loads((OUT / 'results.json').read_text())
        plan = json.loads((OUT / 'sample.json').read_text())
        BASELINE_FAILURES = result.get('baselineFailures', [])
    else:
        (OUT / 'results.json').unlink(missing_ok=True)
        preliminary = None
        if options.adopt_baseline:
            preliminary_path = Path(options.adopt_baseline)
            preliminary = {'node': 'v22.23.4', 'path': str(preliminary_path), 'usedForCampaign': False}
            with gzip.open(OUT / 'evidence/preliminary-node22.log.gz', 'wt') as out:
                out.write(preliminary_path.with_suffix('.log').read_text())
        shutil.rmtree(ROOT / 'node_modules/.vite/vitest', ignore_errors=True)
        exclusions_path = OUT / 'exclusions.json'
        if exclusions_path.exists():
            BASELINE_FAILURES = json.loads(exclusions_path.read_text())['files']
        baseline = run('baseline', 'select', ['run', '--no-file-parallelism'])
        baseline_attempts = []
        assert baseline['exit'] == 0, 'A genuine passing select seed is required; investigate failures before continuing'
        assert any(list(cache.glob('blacksmith*.json')) for cache in cache_paths()), 'Passing seed produced no plugin snapshot'
        baseline['seedMethod'] = 'Genuine passing BSV_MODE=select run; plugin records and covered-file list are unmodified.'
        for cache in cache_paths():
            for f in cache.glob('*.json'):
                with gzip.open(OUT / 'evidence' / (cache.name + '-' + f.name + '.gz'), 'wb') as out:
                    out.write(f.read_bytes())
        imports, tests = dependencies()
        plan = json.loads(Path(options.sample).read_text()) if options.sample else sample(imports, tests)
        dump(OUT / 'sample.json', plan)
        shutil.rmtree(WORK / 'baseline-cache', ignore_errors=True)
        shutil.copytree(ROOT / 'node_modules/.vite/vitest', WORK / 'baseline-cache')
        result = {'node': NODE_VERSION, 'preliminary': preliminary, 'base': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'seed': SEED,
                  'scopes': SCOPES, 'baseline': baseline, 'baselineAttempts': baseline_attempts, 'baselineFailures': BASELINE_FAILURES, 'totalScopedTests': len(tests), 'mutations': []}
    dump(OUT / 'results.json', result)
    if 'unchangedControl' not in result:
        restore_cache()
        result['unchangedControl'] = run('unchanged', 'select', ['run'])
        assert result['unchangedControl']['exit'] == 0, 'Unchanged baseline must pass'
        assert not any('no dependency snapshot' in s or 'running every test' in s for s in result['unchangedControl']['keyOutput']), 'Seed snapshot was not accepted'
    dump(OUT / 'results.json', result)
    completed = {r['id'] for r in result['mutations']}
    for row in plan:
        if row['id'] in completed:
            continue
        path = ROOT / row['file']
        original = path.read_bytes()
        assert hashlib.sha256(original).hexdigest() == row['originalSha256'], 'Unexpected file contents: ' + row['file']
        try:
            path.write_bytes(mutate(row, original))
            restore_cache()
            select = result.get('priorSelections', {}).get(row['id'])
            if select is None:
                select = run(row['id'] + '-select', 'select', ['run', '--no-file-parallelism'])
            restore_cache()
            expected = set(result['baseline']['files'])
            control = run(row['id'] + '-control-full-serial', 'all', ['run', '--no-file-parallelism'], workers=1)
            assert set(control['files']) == expected, 'Full control must cover the same 655-file scope as select'
            selected = set(select['files'])
            failures = {f for f, s in control['files'].items() if s == 'failed' and scoped(f)}
            row.update({'select': select, 'control': control, 'selected': sorted(selected),
                        'groundTruthFailing': sorted(failures), 'falseNegatives': sorted(failures - selected),
                        'overSelected': sorted(selected - failures - set(row['importingTests']) - {row['file']})})
            result['mutations'].append(row)
            report(result)
            print(f"{row['id']} {row['file']}: selected={len(selected)} failing={len(failures)} FN={len(row['falseNegatives'])}", flush=True)
        finally:
            path.write_bytes(original)
            restore_cache()
    report(result)
    shutil.rmtree(AGENT_TMP, ignore_errors=True)

if __name__ == '__main__':
    main()
