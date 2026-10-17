import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import solc from "solc";
import type { Abi, Hex } from "viem";

const moduleParent = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const projectRoot = basename(moduleParent) === 'dist' ? resolve(moduleParent, '..') : moduleParent;
export type ContractArtifact = { contractName: string; compiler: string; abi: Abi; bytecode: Hex; deployedBytecode: Hex };

export function compileContracts(sourceNames?: readonly string[]): Record<string, ContractArtifact> {
  const available = readdirSync(resolve(projectRoot, 'contracts')).filter(name => /^[A-Za-z][A-Za-z0-9_]*\.sol$/.test(name));
  if (sourceNames && (!sourceNames.length || sourceNames.length > 32 || sourceNames.some(name => !available.includes(name)))) {
    throw new Error('Contract compilation source selection is invalid');
  }
  const sourcePaths = [...new Set(sourceNames ?? available)].sort().map(name => 'contracts/' + name);
  const sources = Object.fromEntries(sourcePaths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), "utf8") }]));
  const input = { language: "Solidity", sources, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  } };
  type Output = { errors?: { severity: string; formattedMessage: string }[]; contracts?: Record<string,
    Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: path => {
    // Import resolution is intentionally restricted to the installed OZ package.
    if (!path.startsWith("@openzeppelin/contracts/") || path.includes("..")) return { error: `Unsupported import: ${path}` };
    try { return { contents: readFileSync(resolve(projectRoot, "node_modules", path), "utf8") }; }
    catch { return { error: `Missing dependency import: ${path}` }; }
  } })) as Output;
  const failures = (output.errors ?? []).filter(error => error.severity === "error");
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join("\n"));
  const artifacts: Record<string, ContractArtifact> = {};
  for (const path of sourcePaths) {
    for (const [name, contract] of Object.entries(output.contracts?.[path] ?? {})) {
      artifacts[name] = { contractName: name, compiler: solc.version(), abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}` };
      const target = resolve(projectRoot, "contracts/artifacts", `${name}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(artifacts[name], null, 2) + "\n");
    }
  }
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const artifacts = compileContracts();
  console.log(JSON.stringify({ compiler: solc.version(), contracts: Object.values(artifacts).map(artifact => ({
    name: artifact.contractName, bytecodeBytes: (artifact.bytecode.length - 2) / 2,
    artifact: relative(projectRoot, resolve(projectRoot, "contracts/artifacts", `${artifact.contractName}.json`)),
  })) }, null, 2));
}
