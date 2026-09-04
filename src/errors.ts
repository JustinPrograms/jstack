export class StoryStackError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = "STORY_STACK_ERROR", exitCode = 1) {
    super(message);
    this.name = "StoryStackError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
