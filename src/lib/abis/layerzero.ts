import { parseAbi } from "viem";

/**
 * VibesOFTAdapter — Sourcify full match on Base (0x4080…A381, solc 0.8.24, OFTAdapter + RateLimiter + Pausable + Ownable2Step);
 * the Robinhood reserve adapter (0x37F2…0685) has identical runtime code. NOTE: the RateLimiter is applied to INBOUND
 * credits keyed by the SOURCE eid (VibesOFTGuard), so `creditBudget(srcEid)` on the DESTINATION adapter caps a lane.
 */
export const VIBES_OFT_ADAPTER_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "function quoteSend(SendParam _sendParam, bool _payInLzToken) view returns (MessagingFee msgFee)",
  "function quoteOFT(SendParam _sendParam) view returns (OFTLimit oftLimit, OFTFeeDetail[] oftFeeDetails, OFTReceipt oftReceipt)",
  "function creditBudget(uint32 _srcEid) view returns (uint256 inFlight, uint256 canCredit)",
  "function rateLimits(uint32 eid) view returns (uint192 amountInFlight, uint64 lastUpdated, uint192 limit, uint64 window)",
  "function peers(uint32 eid) view returns (bytes32 peer)",
  "function enforcedOptions(uint32 eid, uint16 msgType) view returns (bytes)",
  "function paused() view returns (bool)",
  "function pauser() view returns (address)",
  "function owner() view returns (address)",
  "function lockedSupply() view returns (uint256)",
  "function decimalConversionRate() view returns (uint256)",
  "error RateLimitExceeded()",
  "error EnforcedPause()",
  "error SlippageExceeded(uint256 amountLD, uint256 minAmountLD)",
  "error NoPeer(uint32 eid)",
  "event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
  "event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)",
  "event RateLimitsChanged((uint32 dstEid, uint192 limit, uint64 window)[] rateLimitConfigs)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event PauserSet(address indexed previous, address indexed current)",
  "event PeerSet(uint32 eid, bytes32 peer)",
]);

/** LayerZero EndpointV2 views used for pathway config, nonce accounting and stuck-packet detection. */
export const LZ_ENDPOINT_V2_ABI = parseAbi([
  "function getSendLibrary(address _sender, uint32 _dstEid) view returns (address lib)",
  "function getReceiveLibrary(address _receiver, uint32 _srcEid) view returns (address lib, bool isDefault)",
  "function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes config)",
  "function delegates(address _oapp) view returns (address)",
  "function outboundNonce(address _sender, uint32 _dstEid, bytes32 _receiver) view returns (uint64)",
  "function inboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)",
  "function lazyInboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)",
  "function inboundPayloadHash(address _receiver, uint32 _srcEid, bytes32 _sender, uint64 _nonce) view returns (bytes32)",
  "event LzReceiveAlert(address indexed receiver, address indexed executor, (uint32 srcEid, bytes32 sender, uint64 nonce) origin, bytes32 guid, uint256 gas, uint256 value, bytes message, bytes extraData, bytes reason)",
]);

/** Worker fee views (separate ABIs: both are named getFee). Sum(executor + DVNs + treasury) == quoteSend().nativeFee (verified). */
export const LZ_EXECUTOR_FEE_ABI = parseAbi([
  "function getFee(uint32 _dstEid, address _sender, uint256 _calldataSize, bytes _options) view returns (uint256)",
]);
export const LZ_DVN_FEE_ABI = parseAbi([
  "function getFee(uint32 _dstEid, uint64 _confirmations, address _sender, bytes _options) view returns (uint256)",
]);
