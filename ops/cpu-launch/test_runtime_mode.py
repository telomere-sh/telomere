"""Optimization must fail before recovery tooling imports or performs any I/O."""
import ast
import os
from pathlib import Path
import subprocess
import sys
import unittest


class CheckedPythonModeTests(unittest.TestCase):
    def protected_tools(self):
        tools = []
        for directory in (Path(__file__).parent, Path(__file__).parent.parent / 'cpu-cloud'):
            for path in sorted(directory.glob('*.py')):
                if path.name.startswith('test_'):
                    continue
                if any(isinstance(node, ast.Assert) for node in ast.walk(ast.parse(path.read_text(encoding='utf-8')))):
                    tools.append(path)
        self.assertGreater(len(tools), 10, 'Inventory must include the actual operator trust boundaries')
        return tools

    def check_mode(self, arguments, optimize=None):
        environment = {k: v for k, v in os.environ.items() if k.upper() != 'PYTHONOPTIMIZE'}
        if optimize is not None:
            environment['PYTHONOPTIMIZE'] = optimize
        for path in self.protected_tools():
            with self.subTest(tool=path.name, arguments=arguments, optimize=optimize):
                result = subprocess.run([sys.executable, *arguments, '-B', '-c',
                                         'import runpy,sys; runpy.run_path(sys.argv[1])', str(path)],
                                        capture_output=True, text=True, env=environment, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Telomere recovery tooling requires checked Python', result.stderr)
                self.assertNotIn('ModuleNotFoundError', result.stderr, 'Guard must execute before optional imports')

    def test_optimized_interpreter_rejects_every_assert_based_tool(self):
        self.check_mode(['-O'])

    def test_double_optimization_rejects_every_assert_based_tool(self):
        self.check_mode(['-OO'])

    def test_optimization_environment_rejects_every_assert_based_tool(self):
        self.check_mode([], '1')


if __name__ == '__main__':
    unittest.main()
