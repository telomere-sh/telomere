import { decodeEventLog, parseAbi, toEventSelector, type Hex } from 'viem';
import type { SelectionAgentView, SelectionFossilView } from './schema.js';
import type { SelectionBlock, SelectionLog } from './rpc.js';

export const selectionRegistryEvents = parseAbi([
  'event Birth(bytes32 indexed agentId, bytes32 indexed parent, address indexed owner, uint256 identityId, address vault, bytes32 leashId, uint96 endowment, bytes32 cystHash)',
  'event Income(bytes32 indexed agentId, uint96 amount, uint96 fee, address indexed source, bytes32 paymentRef)',
  'event Subsidy(bytes32 indexed agentId, uint96 amount, address indexed source, bytes32 paymentRef)',
  'event Burn(bytes32 indexed agentId, uint96 amount, bytes32 indexed runId, uint64 paidAt)',
  'event Dormant(bytes32 indexed agentId, uint64 dormantAt, uint64 deathAt)',
  'event GraceExtended(bytes32 indexed agentId, uint64 deathAt)',
  'event Death(bytes32 indexed agentId, uint64 lifespan, uint256 lifetimeIncome, uint256 lifetimeBurn, bytes32 cause)',
  'event Revived(bytes32 indexed agentId)',
  'event Spawn(bytes32 indexed parentId, bytes32 indexed childId, uint96 endowment, bytes32 cystHash)',
  'event Frozen(bytes32 indexed agentId, bool frozen, string reason, bytes32 evidence)',
  'event CystCommitted(bytes32 indexed agentId, bytes32 cystHash)',
]);
export const selectionVaultEvents = parseAbi([
  'event OwnerWithdrawn(address indexed owner, uint96 amount)',
  'event FundsReceived(address indexed source, uint96 grossAmount, uint96 incomeFee, bytes32 paymentRef)',
  'event ChildFunded(address indexed childVault, uint96 amount)',
  'event RunFunded(bytes32 indexed runId, uint96 ceiling)',
  'event RunFinalized(bytes32 indexed runId, uint96 charge, bool refunded)',
]);
const registryTopics = new Set(selectionRegistryEvents.map(event => toEventSelector(event)));
const vaultTopics = new Set(selectionVaultEvents.map(event => toEventSelector(event)));
export interface SelectionDecodedEvent extends SelectionLog { name: string; args: Record<string, string | boolean> }
export function decodeSelectionEvent(log: SelectionLog, registry: string): SelectionDecodedEvent | undefined {
  try {
    const event = decodeEventLog({ abi: log.address === registry ? selectionRegistryEvents : selectionVaultEvents,
      topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    const args = Object.fromEntries(Object.entries(event.args).map(([key, value]) => [key,
      typeof value === 'bigint' ? value.toString() : typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value]));
    if (Object.values(args).some(value => typeof value !== 'string' && typeof value !== 'boolean')) throw new Error('Unsupported Selection event field');
    return { ...log, name: event.eventName, args: args as Record<string, string | boolean> };
  } catch {
    if ((log.address === registry ? registryTopics : vaultTopics).has(log.topics[0] ?? '0x')) throw new Error('Malformed indexed Selection event');
    return undefined;
  }
}
const zero = '0x' + '00'.repeat(32);
const string = (event: SelectionDecodedEvent, name: string) => { const value = event.args[name]; if (typeof value !== 'string') throw new Error('Incomplete Selection event'); return value; };
const amount = (event: SelectionDecodedEvent, name: string) => { const value = string(event, name); if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid Selection units'); return BigInt(value); };
function increment(agent: SelectionAgentView, key: 'income' | 'incomeFees' | 'burn' | 'subsidy' | 'ownerWithdrawals' | 'childFunding', value: bigint) {
  const next = BigInt(agent[key]) + value; if (next < 0n || next >= 2n ** 256n) throw new Error('Selection accounting overflow'); agent[key] = next.toString();
}
export function selectionProjection(events: readonly SelectionDecodedEvent[], blocks: ReadonlyMap<bigint, SelectionBlock>, registry: string) {
  const agents = new Map<string, SelectionAgentView>(), fossils = new Map<string, SelectionFossilView>(), vaultAgents = new Map<string, string>();
  const classified = new Map<string, { source: string; amount: string; fee: string; paymentRef: string }[]>();
  for (const event of events) {
    const block = blocks.get(event.height); if (!block || block.hash !== event.blockHash) throw new Error('Selection event is not anchored to an indexed canonical block');
    if (event.address === registry && event.name === 'Birth') {
      const agentId = string(event, 'agentId'), parentId = string(event, 'parent'), parent = agents.get(parentId);
      if (agents.has(agentId) || parentId !== zero && !parent) throw new Error('Selection start block omitted an ancestor or duplicate birth');
      const vault = string(event, 'vault'); if (vaultAgents.has(vault)) throw new Error('Duplicate Selection vault');
      const record: SelectionAgentView = { agentId, owner: string(event, 'owner'), vault, identityId: string(event, 'identityId'),
        leashId: string(event, 'leashId'), parent: parentId, family: parent?.family ?? agentId, generation: (parent?.generation ?? -1) + 1,
        cystHash: string(event, 'cystHash'), status: 'alive', frozen: false, bornAt: block.timestamp.toString(), birthBlock: event.height.toString(),
        dormantAt: null, deathAt: null, diedAt: null, lastPaidAt: '0', lastActivationAt: block.timestamp.toString(),
        income: '0', incomeFees: '0', burn: '0', subsidy: '0', ownerWithdrawals: '0', childFunding: '0', openRuns: 0, livingChildren: 0, offspring: 0 };
      if (parent) { parent.livingChildren++; parent.offspring++; } agents.set(agentId, record); vaultAgents.set(vault, agentId); continue;
    }
    const id = event.address === registry ? (event.name === 'Spawn' ? string(event, 'parentId') : string(event, 'agentId')) : vaultAgents.get(event.address);
    const agent = id ? agents.get(id) : undefined; if (!agent) throw new Error('Selection event references an unindexed agent or vault');
    const classificationKey = event.transactionHash + ':' + agent.agentId;
    if (event.address === registry) {
      switch (event.name) {
        case 'Income': case 'Subsidy': {
          if (agent.status === 'dead') throw new Error('Dead Selection agent received classified funds');
          const value = amount(event, 'amount'), fee = event.name === 'Income' ? amount(event, 'fee') : 0n;
          if (fee > value) throw new Error('Invalid Selection income fee');
          increment(agent, event.name === 'Income' ? 'income' : 'subsidy', value); increment(agent, 'incomeFees', fee);
          const pending = classified.get(classificationKey) ?? [];
          pending.push({ source: string(event, 'source'), amount: value.toString(), fee: fee.toString(), paymentRef: string(event, 'paymentRef') }); classified.set(classificationKey, pending); break;
        }
        case 'Burn': {
          const paidAt = amount(event, 'paidAt'); if (paidAt > block.timestamp) throw new Error('Selection burn is dated in the future');
          increment(agent, 'burn', amount(event, 'amount')); if (paidAt > BigInt(agent.lastPaidAt)) agent.lastPaidAt = paidAt.toString(); break;
        }
        case 'Dormant': agent.status = 'dormant'; agent.dormantAt = amount(event, 'dormantAt').toString(); agent.deathAt = amount(event, 'deathAt').toString(); break;
        case 'GraceExtended': agent.deathAt = amount(event, 'deathAt').toString(); break;
        case 'Revived': if (agent.status !== 'dormant') throw new Error('Invalid indexed Selection revival');
          agent.status = 'alive'; agent.dormantAt = null; agent.deathAt = null; agent.lastActivationAt = block.timestamp.toString(); break;
        case 'Death': {
          if (agent.status !== 'dormant' || fossils.has(agent.agentId) || amount(event, 'lifetimeIncome').toString() !== agent.income
            || amount(event, 'lifetimeBurn').toString() !== agent.burn || amount(event, 'lifespan') !== block.timestamp - BigInt(agent.bornAt)) throw new Error('Selection death disagrees with lifetime accounting');
          agent.status = 'dead'; agent.diedAt = block.timestamp.toString(); const net = BigInt(agent.income) - BigInt(agent.incomeFees);
          fossils.set(agent.agentId, { agentId: agent.agentId, owner: agent.owner, family: agent.family, parent: agent.parent, generation: agent.generation,
            identityId: agent.identityId, vault: agent.vault, bornAt: agent.bornAt, diedAt: agent.diedAt, lifespanSeconds: string(event, 'lifespan'),
            deathBlock: event.height.toString(), deathBlockHash: event.blockHash, deathTransaction: event.transactionHash, cause: string(event, 'cause'),
            lifetimeIncome: agent.income, lifetimeIncomeFees: agent.incomeFees, lifetimeNetIncome: net.toString(), lifetimeBurn: agent.burn,
            lifetimeSubsidy: agent.subsidy, survivalRatio: agent.burn === '0' ? null : { numerator: net.toString(), denominator: agent.burn }, cystHash: agent.cystHash, offspring: agent.offspring });
          const parent = agents.get(agent.parent); if (parent) { if (parent.livingChildren <= 0) throw new Error('Selection child accounting underflow'); parent.livingChildren--; } break;
        }
        case 'Spawn': {
          const child = agents.get(string(event, 'childId')); if (!child || child.parent !== agent.agentId || child.cystHash !== string(event, 'cystHash')) throw new Error('Selection spawn disagrees with birth'); break;
        }
        case 'Frozen': if (typeof event.args.frozen !== 'boolean') throw new Error('Invalid freeze event'); agent.frozen = event.args.frozen; break;
        case 'CystCommitted': agent.cystHash = string(event, 'cystHash'); break;
        default: throw new Error('Unsupported Selection registry event');
      }
    } else {
      switch (event.name) {
        case 'FundsReceived': {
          const pending = classified.get(classificationKey) ?? [], source = string(event, 'source'), value = amount(event, 'grossAmount').toString(), fee = amount(event, 'incomeFee').toString();
          const position = pending.findIndex(item => item.source === source && item.amount === value && item.fee === fee && item.paymentRef === string(event, 'paymentRef'));
          if (position < 0) throw new Error('Vault funds have no matching registry income/subsidy classification'); pending.splice(position, 1); break;
        }
        case 'OwnerWithdrawn': if (string(event, 'owner') !== agent.owner) throw new Error('Vault withdrawal owner changed'); increment(agent, 'ownerWithdrawals', amount(event, 'amount')); break;
        case 'ChildFunded': increment(agent, 'childFunding', amount(event, 'amount')); break;
        case 'RunFunded': agent.openRuns++; break;
        case 'RunFinalized': if (agent.openRuns <= 0) throw new Error('Vault open-run accounting underflow'); agent.openRuns--; break;
        default: throw new Error('Unsupported Selection vault event');
      }
    }
  }
  return { agents, fossils };
}
