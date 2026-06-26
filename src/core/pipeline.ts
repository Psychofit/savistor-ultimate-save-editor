/**
 * A transform pipeline is an ordered stack of codec steps describing how a save
 * file is wrapped, outermost first. To *open* the file we `decode` top-to-bottom;
 * to *re-save* after editing we `encode` bottom-to-top, reversing the stack so
 * the rebuilt file matches the original structure.
 *
 *   raw bytes --decode[0]--> --decode[1]--> ... --> editable payload
 *   editable payload --encode[n-1]--> ... --encode[0]--> raw bytes
 */

import { CodecOptions, getCodec } from "./codecs";

export interface PipelineStep {
  codecId: string;
  options?: CodecOptions;
}

export interface StepTrace {
  codecId: string;
  ok: boolean;
  outputSize: number;
  error?: string;
}

export interface PipelineRun {
  output: Uint8Array;
  /** Per-step result; stops at the first failure. */
  trace: StepTrace[];
  ok: boolean;
}

/** Decode forward through the steps. Stops and reports the first failing step. */
export function decodePipeline(input: Uint8Array, steps: PipelineStep[]): PipelineRun {
  let current = input;
  const trace: StepTrace[] = [];
  for (const step of steps) {
    const codec = getCodec(step.codecId);
    if (!codec) {
      trace.push({ codecId: step.codecId, ok: false, outputSize: 0, error: "unknown codec" });
      return { output: current, trace, ok: false };
    }
    try {
      current = codec.decode(current, step.options);
      trace.push({ codecId: step.codecId, ok: true, outputSize: current.length });
    } catch (e) {
      trace.push({
        codecId: step.codecId,
        ok: false,
        outputSize: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      return { output: current, trace, ok: false };
    }
  }
  return { output: current, trace, ok: true };
}

/** Encode the edited payload back through the steps in reverse order. */
export function encodePipeline(payload: Uint8Array, steps: PipelineStep[]): PipelineRun {
  let current = payload;
  const trace: StepTrace[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const codec = getCodec(step.codecId);
    if (!codec) {
      trace.push({ codecId: step.codecId, ok: false, outputSize: 0, error: "unknown codec" });
      return { output: current, trace, ok: false };
    }
    try {
      current = codec.encode(current, step.options);
      trace.push({ codecId: step.codecId, ok: true, outputSize: current.length });
    } catch (e) {
      trace.push({
        codecId: step.codecId,
        ok: false,
        outputSize: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      return { output: current, trace, ok: false };
    }
  }
  return { output: current, trace, ok: true };
}
