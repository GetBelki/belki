const SHARD_ACCESSORS = [
  (env: Env) => env.SNAPSHOT_DB_00,
  (env: Env) => env.SNAPSHOT_DB_01,
  (env: Env) => env.SNAPSHOT_DB_02,
  (env: Env) => env.SNAPSHOT_DB_03,
  (env: Env) => env.SNAPSHOT_DB_04,
  (env: Env) => env.SNAPSHOT_DB_05,
  (env: Env) => env.SNAPSHOT_DB_06,
  (env: Env) => env.SNAPSHOT_DB_07,
  (env: Env) => env.SNAPSHOT_DB_08,
  (env: Env) => env.SNAPSHOT_DB_09,
  (env: Env) => env.SNAPSHOT_DB_10,
  (env: Env) => env.SNAPSHOT_DB_11,
  (env: Env) => env.SNAPSHOT_DB_12,
  (env: Env) => env.SNAPSHOT_DB_13,
  (env: Env) => env.SNAPSHOT_DB_14,
  (env: Env) => env.SNAPSHOT_DB_15,
  (env: Env) => env.SNAPSHOT_DB_16,
  (env: Env) => env.SNAPSHOT_DB_17,
  (env: Env) => env.SNAPSHOT_DB_18,
  (env: Env) => env.SNAPSHOT_DB_19,
  (env: Env) => env.SNAPSHOT_DB_20,
  (env: Env) => env.SNAPSHOT_DB_21,
  (env: Env) => env.SNAPSHOT_DB_22,
  (env: Env) => env.SNAPSHOT_DB_23,
  (env: Env) => env.SNAPSHOT_DB_24,
  (env: Env) => env.SNAPSHOT_DB_25,
  (env: Env) => env.SNAPSHOT_DB_26,
  (env: Env) => env.SNAPSHOT_DB_27,
  (env: Env) => env.SNAPSHOT_DB_28,
  (env: Env) => env.SNAPSHOT_DB_29,
  (env: Env) => env.SNAPSHOT_DB_30,
  (env: Env) => env.SNAPSHOT_DB_31,
] as const;

export const SHARD_COUNT = SHARD_ACCESSORS.length;

export function getShard(env: Env, shardId: number): D1Database {
  const accessor = SHARD_ACCESSORS[shardId];
  if (!accessor) throw new RangeError(`Invalid snapshot shard: ${shardId}`);
  return accessor(env);
}
