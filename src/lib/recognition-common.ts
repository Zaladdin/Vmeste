export class RecognitionError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "RecognitionError";
  }
}
export const RECOGNITION_TIMEOUT_MS = 240_000;
export const RECOGNITION_RETRY_DELAY_MS = 260_000;
