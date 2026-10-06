export type HiveOperation = [type: string, payload: unknown];

export interface HiveTransaction {
  expiration?: string;
  operations?: HiveOperation[];
}

export interface HiveBlock {
  previous?: string;
  timestamp: string;
  witness: string;
  transaction_merkle_root?: string;
  extensions?: unknown[];
  transaction_ids?: string[];
  transactions?: HiveTransaction[];
  block_id?: string;
  signing_key?: string;
}

export interface TransactionRef {
  id: string;
  expiration?: string;
  primaryOperationType?: string;
}

export type TransactionStatusName =
  | "within_mempool"
  | "within_reversible_block"
  | "within_irreversible_block"
  | "expired_reversible"
  | "expired_irreversible"
  | "too_old"
  | "unknown"
  | string;

export interface TransactionStatusResponse {
  status: TransactionStatusName;
  block_num?: number;
  rc_cost?: number;
}

export interface AppliedOperation {
  op?: HiveOperation;
  virtual_op?: number;
  [key: string]: unknown;
}

export interface DynamicGlobalProperties {
  head_block_number: number;
  head_block_id?: string;
  time: string;
  current_witness?: string;
  current_supply?: string;
  current_hbd_supply?: string;
  total_vesting_fund_hive?: string;
  total_vesting_shares?: string;
  hbd_interest_rate?: number;
  hbd_print_rate?: number;
  maximum_block_size?: number;
  current_aslot?: number;
  participation_count?: number;
  last_irreversible_block_num?: number;
  available_account_subsidies?: number;
  next_maintenance_time?: string;
  last_budget_time?: string;
  next_daily_maintenance_time?: string;
  dhf_interval_ledger?: string;
  [key: string]: unknown;
}

export interface NextScheduledHardfork {
  hf_version?: string;
  hardfork_version?: string;
  live_time?: string;
  [key: string]: unknown;
}

export interface HardforkInfo {
  currentVersion?: string;
  nextVersion?: string;
  nextLiveTime?: string;
}

export interface WitnessSchedule {
  current_shuffled_witnesses?: string[];
  future_shuffled_witnesses?: string[];
  future_changes?: unknown;
  num_scheduled_witnesses?: number;
  next_shuffle_block_num?: number;
  rpcEndpoint?: string;
  rpcRequestId?: string;
  rpcParamHash?: string;
  rpcFetchedAt?: string;
  [key: string]: unknown;
}

export interface ScheduleDiagnostics {
  kind: "possible_rpc_backend_drift";
  message: string;
  endpoint?: string;
  changedAtBlock: number;
  previousRequestId?: string;
  requestId?: string;
}

export interface WitnessByVote {
  owner?: string;
  votes?: string;
  last_hbd_exchange_update?: string;
  running_version?: string;
  [key: string]: unknown;
}

export type WitnessRanks = Record<string, number>;
export type WitnessFeedUpdates = Record<string, string>;
export type WitnessVersions = Record<string, string>;

export interface MissedBlock {
  witness: string;
  detectedAtBlock: number;
  detectedAt: string;
}

export interface RcStatsOperation {
  count?: number;
  avg_cost?: number;
}

export interface RcStatsPayer {
  rank?: number;
  count?: number;
  lt5?: number;
  lt10?: number;
  lt20?: number;
  cant_afford?: {
    vote?: number;
    comment?: number;
    transfer?: number;
  };
}

export interface RcStats {
  vote?: number;
  comment?: number;
  transfer?: number;
  ops?: Record<string, RcStatsOperation>;
  payers?: RcStatsPayer[];
  [key: string]: unknown;
}

export interface RcStatsResponse {
  rc_stats?: RcStats;
}

export interface RcInfo {
  voteCost?: number;
  commentCost?: number;
  transferCost?: number;
  lowRcUnder5: number;
  lowRcUnder20: number;
  cantAffordVote: number;
  cantAffordComment: number;
  topOperation?: string;
}

export interface BlockRecord {
  number: number;
  timestamp: Date;
  witness: string;
  transactionCount: number;
  transactions: TransactionRef[];
  operationCount: number;
  virtualOperationCount: number;
  operationTypes: Map<string, number>;
}

export interface FollowerMetadata {
  hardforkInfo?: HardforkInfo;
  rcInfo?: RcInfo;
  witnessRanks: WitnessRanks;
  witnessFeedUpdates: WitnessFeedUpdates;
  witnessVersions: WitnessVersions;
  majorityWitnessVersion?: string;
  scheduleDiagnostics?: ScheduleDiagnostics;
  missedBlocks: MissedBlock[];
}

export type FollowerEvent = FollowerMetadata & (
  | {
      type: "status";
      headBlock: number;
      nextBlock: number;
      lag: number;
      dynamicGlobalProperties: DynamicGlobalProperties;
      witnessSchedule?: WitnessSchedule;
    }
  | {
      type: "block";
      block: BlockRecord;
      headBlock: number;
      lag: number;
      dynamicGlobalProperties: DynamicGlobalProperties;
      witnessSchedule?: WitnessSchedule;
    }
  | {
      type: "gap";
      blockNumber: number;
      retryInMs: number;
      dynamicGlobalProperties: DynamicGlobalProperties;
      witnessSchedule?: WitnessSchedule;
    }
  | {
      type: "retry";
      message: string;
      retryInMs: number;
    }
);
