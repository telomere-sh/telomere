"""Run the exact scanners, retain raw findings, and enforce reviewed source bindings."""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = ROOT / '.local/security-reports'
    output.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or not output.is_dir():
        raise RuntimeError('Unsafe scanner output directory')
    suffix = '.exe' if os.name == 'nt' else ''
    binary = ROOT / '.local/security-bin'
    slither = Path(sys.executable).with_name('slither' + suffix)
    commands = {
        'gitleaks': [str(binary / ('gitleaks' + suffix)), 'git', '--log-opts=--all', '--redact=100', '--no-banner',
                     '--report-format=json', '--report-path=' + str(output / 'gitleaks.json'), str(ROOT)],
        # Keep the established direct-solc scope after adding foundry.toml for
        # independent properties. Auto-detection would silently select a different
        # build system (and require Forge in the scanner environment).
        'slither': [str(slither), 'contracts', '--compile-force-framework', 'solc', '--foundry-ignore',
                    '--solc', str(binary / ('solc' + suffix)),
                    '--solc-remaps', '@openzeppelin/=node_modules/@openzeppelin/', '--solc-args',
                    '--optimize --optimize-runs 200 --evm-version paris', '--exclude-dependencies', '--json', str(output / 'slither.json')],
    }
    module = importlib.util.spec_from_file_location('finding_gate', ROOT / 'security/check-findings.py')
    gate = importlib.util.module_from_spec(module)
    module.loader.exec_module(gate)
    outcomes = []
    for tool, command in commands.items():
        report = output / (tool + '.json')
        # Never accept a stale scanner report after a failed fresh invocation.
        if report.exists():
            if not report.is_file() or report.is_symlink():
                raise RuntimeError('Unsafe scanner report output')
            report.unlink()
        with (output / (tool + '.log')).open('w', encoding='utf-8') as log:
            result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        if result.returncode not in (0, 1, 255, -1, 4294967295) or not report.is_file():
            raise RuntimeError(tool + ' did not produce a fresh reviewable report')
        outcome = gate.review(tool, json.loads(report.read_text(encoding='utf-8-sig')))
        outcome['scannerExitCode'] = result.returncode
        outcomes.append(outcome)
        (output / (tool + '-gate.json')).write_text(json.dumps(outcome, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(outcome))
    if not all(item['passed'] for item in outcomes):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
