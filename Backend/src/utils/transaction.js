import mongoose from 'mongoose';

/// Multi-document transactions only exist on a replica set or sharded cluster.
/// The shared VPS runs a standalone mongod, where `startTransaction()` makes the
/// first write fail with "Transaction numbers are only allowed on a replica set
/// member or mongos" - which broke every ride completion (wallet settlement),
/// promo booking, bid acceptance and wallet top-up there.
///
/// These helpers keep the session (sessions work on a standalone server, and
/// every `{ session }` option stays valid) and only open a transaction when the
/// deployment supports one. On a replica set nothing changes. On a standalone
/// server the writes run one by one; the code paths that use this already guard
/// themselves with conditional updates (e.g. `walletSettledAt: null`), so a
/// retry cannot double-apply.
const TRANSACTIONAL_TOPOLOGIES = new Set(['ReplicaSetWithPrimary', 'Sharded', 'LoadBalanced']);

export const transactionsSupported = () => {
  const type = mongoose.connection?.client?.topology?.description?.type;
  return TRANSACTIONAL_TOPOLOGIES.has(type);
};

export const beginTransaction = (session) => {
  if (session && transactionsSupported()) {
    session.startTransaction();
  }
};

export const commitTransaction = async (session) => {
  if (session?.inTransaction()) {
    await session.commitTransaction();
  }
};

export const abortTransaction = async (session) => {
  if (session?.inTransaction()) {
    await session.abortTransaction();
  }
};
