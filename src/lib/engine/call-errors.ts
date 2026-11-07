/**
 * Tell a contract-level "no" (revert / empty return data — the function does not exist or refused) apart
 * from an RPC failure (rate limit, timeout, HTTP error). Only the former is a real answer; the latter
 * must surface as UNKNOWN so nothing is reported clean because an RPC call failed.
 */
const ANSWER_ERRORS = new Set([
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
  "AbiDecodingZeroDataError",
  "AbiDecodingDataSizeTooSmallError",
  "AbiDecodingOffsetOutOfBoundsError",
  "PositionOutOfBoundsError",
  "InvalidAddressError",
  "CallExecutionError", // geth "execution reverted" surfaced without revert data
]);

export function isContractAnswer(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const err = e as { name?: string; message?: string; shortMessage?: string; details?: string; cause?: unknown };
    if (err.name && ANSWER_ERRORS.has(err.name)) {
      // CallExecutionError also wraps transport failures: accept it only when it is a revert.
      if (err.name !== "CallExecutionError") return true;
      if (/revert/i.test(`${err.details ?? ""} ${err.shortMessage ?? ""} ${err.message ?? ""}`)) return true;
    }
    if (/execution reverted|returned no data|reverted/i.test(err.shortMessage ?? "")) return true;
    e = err.cause;
  }
  return false;
}

/** A multicall result that failed for a NON-contract reason (RPC/transport). */
export function isRpcFailure(r: { status: "success" | "failure"; error?: unknown } | null | undefined): boolean {
  return !!r && r.status === "failure" && !isContractAnswer(r.error);
}
