ChatGPT to Box Streaming v0.2.8

Quick resume verifies only the last completed Box part against the original source URL. Earlier parts are located by Box file metadata (name, size and Box SHA-1), without requiring .sha1 sidecars. Existing parts are never overwritten. After all parts are uploaded, the program still performs full source and Box verification. Only after successful full verification does it upload missing per-part .sha1 sidecars. Existing sidecars are left alone.

IMPORTANT: Because an earlier version could upload the wrong source, quick resume alone cannot prove earlier parts are correct. Full end-of-transfer verification remains mandatory and may take considerable time. If the original URL has expired, final verification cannot complete.
