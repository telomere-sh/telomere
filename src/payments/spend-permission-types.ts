import { z } from 'zod';
import { keccak256, toHex } from 'viem';
import { addressSchema, bytes32Schema } from '../common.js';

// Dependency leaf: quote schemas must never import chain proof readers.
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const uint160 = uint.refine(value => BigInt(value) < 2n ** 160n);
const uint256 = uint.refine(value => BigInt(value) < 2n ** 256n);
const uint48 = z.number().int().nonnegative().max(2 ** 48 - 1);
export const spendPermissionSchema = z.object({ account: addressSchema, spender: addressSchema, token: addressSchema,
  allowance: uint160.refine(value => BigInt(value) > 0n), period: uint48.positive(), start: uint48, end: uint48,
  salt: uint256, extraData: z.string().regex(/^0x(?:[a-fA-F0-9]{2}){224}$/) }).strict()
  .refine(value => value.end > value.start, 'Spend permission time window is invalid');
export type SpendPermission = z.infer<typeof spendPermissionSchema>;
export const spendPermissionFundingSchema = z.object({ kind: z.literal('base_spend_permission_v1'),
  permission: spendPermissionSchema }).strict();
export const spendPermissionProfileSchema = z.object({ kind: z.literal('base_spend_permission_v1'),
  managerAddress: addressSchema, managerCodeHash: bytes32Schema }).strict();
export const SPEND_PERMISSION_MANAGER = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
export const SPEND_PERMISSION_TYPE = 'SpendPermission(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export const SPEND_PERMISSION_TYPEHASH = keccak256(toHex(SPEND_PERMISSION_TYPE));
export const SPEND_PERMISSION_LEASH_DOMAIN = keccak256(toHex('TelomereSpendPermissionLeashV1'));
