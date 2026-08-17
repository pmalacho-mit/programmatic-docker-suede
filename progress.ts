/**
 * Reader for the Docker Engine's newline-delimited JSON progress streams
 * (`/build`, `/images/create`).
 *
 * The two builders report themselves very differently:
 *
 * - The **classic** builder sends `{ "stream": "..." }` text, then a final
 *   `{ "error": ..., "errorDetail": ... }` if the build failed.
 * - **BuildKit** (`version: "2"`) sends `{ "id": "moby.buildkit.trace", "aux": "<base64>" }`
 *   records: a base64-encoded protobuf `moby.buildkit.v1.StatusResponse` holding
 *   the vertices of the build graph and their log output. A failed step shows up
 *   as an `error` on its vertex.
 *
 * `dockerode.followProgress` handles neither well — it forwards BuildKit's RUN
 * output *still base64-encoded*, and its completion callback reports no error
 * for a failed build (classic or BuildKit) — so this module does the decoding
 * and failure detection itself.
 */

// ---------------------------------------------------------------------------
// protobuf wire format
//
// Just enough of a decoder to read the trace records; a full protobuf runtime
// would be a heavy dependency for three message types.
// https://protobuf.dev/programming-guides/encoding/
// ---------------------------------------------------------------------------

/**
 * A varint carries 7 payload bits per byte, least-significant group first,
 * with the high bit set on every byte except the last.
 */
const VARINT_PAYLOAD_BITS = 7n;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_MORE_FLAG = 0x80;

/** Read a base-128 varint, returning its value and the offset just past it. */
const varint = (buf: Buffer, at: number): [value: bigint, next: number] => {
  let value = 0n;
  let shift = 0n;
  let pos = at;
  while (pos < buf.length) {
    const byte = buf[pos++]!;
    value |= BigInt(byte & VARINT_PAYLOAD_MASK) << shift;
    if ((byte & VARINT_MORE_FLAG) === 0) break;
    shift += VARINT_PAYLOAD_BITS;
  }
  return [value, pos];
};

/**
 * How to read the bytes that follow a field's tag.
 * https://protobuf.dev/programming-guides/encoding/#structure
 */
const WireType = {
  /** `int32`/`int64`, `bool` and `enum`, varint-encoded. */
  Varint: 0,
  /** `fixed64`, `sfixed64`, `double`. */
  Fixed64: 1,
  /** A varint length, then that many bytes: strings, bytes, nested messages. */
  LengthDelimited: 2,
  /** `fixed32`, `sfixed32`, `float`. */
  Fixed32: 5,
} as const;

const FIXED_64_BYTES = 8;
const FIXED_32_BYTES = 4;

/**
 * Every field opens with a tag varint packing its number together with its
 * wire type: `tag = (fieldNumber << 3) | wireType`.
 */
const TAG_WIRE_TYPE_BITS = 3n;
const TAG_WIRE_TYPE_MASK = 0b111n;

const fieldNumberOf = (tag: bigint) => Number(tag >> TAG_WIRE_TYPE_BITS);
const wireTypeOf = (tag: bigint) => Number(tag & TAG_WIRE_TYPE_MASK);

/** A single wire-format field: varints as `varint`, everything else as bytes. */
type Field = { no: number; varint?: bigint; bytes?: Buffer };

/** Walk the fields of an encoded message, stopping at anything unparseable. */
function* fields(buf: Buffer): Generator<Field> {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = varint(buf, pos);
    const no = fieldNumberOf(tag);
    const wire = wireTypeOf(tag);
    switch (wire) {
      case WireType.Varint: {
        const [value, next] = varint(buf, afterTag);
        yield { no, varint: value };
        pos = next;
        break;
      }
      case WireType.Fixed64:
      case WireType.Fixed32: {
        const width =
          wire === WireType.Fixed64 ? FIXED_64_BYTES : FIXED_32_BYTES;
        yield { no, bytes: buf.subarray(afterTag, afterTag + width) };
        pos = afterTag + width;
        break;
      }
      case WireType.LengthDelimited: {
        const [length, afterLength] = varint(buf, afterTag);
        const end = afterLength + Number(length);
        yield { no, bytes: buf.subarray(afterLength, end) };
        pos = end;
        break;
      }
      default:
        // The deprecated group types (3 and 4) and anything unrecognized carry
        // no length to skip by, so the next field can't be found.
        return;
    }
  }
}

/** Decode a `string` or `bytes` field. */
const utf8 = (field: Field) => field.bytes?.toString("utf-8") ?? "";

/** Decode a `bool` field, which travels as a varint. */
const bool = (field: Field) => field.varint !== 0n;

// ---------------------------------------------------------------------------
// moby.buildkit.v1.StatusResponse
// ---------------------------------------------------------------------------

/**
 * Field numbers, straight from buildkit's
 * [control.proto](https://github.com/moby/buildkit/blob/master/api/services/control/control.proto).
 * Only the fields needed to print a build log and spot a failure are listed —
 * timings, progress groups and source positions are skipped.
 */
const FIELD = {
  /** `StatusResponse`: one trace record, describing whatever just changed. */
  status: { vertexes: 1, logs: 3, warnings: 4 },
  /** `Vertex`: a node of the build graph, i.e. a build step. */
  vertex: { digest: 1, name: 3, cached: 4, completed: 6, error: 7 },
  /** `VertexLog`: output written by a step. */
  log: { vertex: 1, msg: 4 },
  /** `VertexWarning`: e.g. a deprecated Dockerfile directive. */
  warning: { short: 3 },
} as const;

type Vertex = {
  /** Content digest identifying this step across trace records. */
  digest: string;
  /** Human-readable step name, e.g. `[2/3] RUN npm ci`. */
  name?: string;
  cached: boolean;
  completed: boolean;
  /** Present when the step failed. */
  error?: string;
};

type VertexLog = {
  /** Digest of the step that produced this output. */
  vertex: string;
  /** A slice of that step's output — stdout and stderr, not split apart. */
  text: string;
};

const decodeVertex = (buf: Buffer): Vertex => {
  const vertex: Vertex = { digest: "", cached: false, completed: false };
  for (const field of fields(buf))
    if (field.no === FIELD.vertex.digest) vertex.digest = utf8(field);
    else if (field.no === FIELD.vertex.name) vertex.name = utf8(field);
    else if (field.no === FIELD.vertex.cached) vertex.cached = bool(field);
    // `completed` is a timestamp; that it was sent at all is what marks the
    // step finished.
    else if (field.no === FIELD.vertex.completed) vertex.completed = true;
    else if (field.no === FIELD.vertex.error) vertex.error = utf8(field);
  return vertex;
};

const decodeLog = (buf: Buffer): VertexLog => {
  const log: VertexLog = { vertex: "", text: "" };
  for (const field of fields(buf))
    if (field.no === FIELD.log.vertex) log.vertex = utf8(field);
    else if (field.no === FIELD.log.msg) log.text = utf8(field);
  return log;
};

/** Read a `VertexWarning`'s one-line `short` summary. */
const decodeWarning = (buf: Buffer): string => {
  for (const field of fields(buf))
    if (field.no === FIELD.warning.short) return utf8(field);
  return "";
};

const decodeStatus = (buf: Buffer) => {
  const vertexes: Vertex[] = [];
  const logs: VertexLog[] = [];
  const warnings: string[] = [];
  for (const field of fields(buf))
    if (field.no === FIELD.status.vertexes && field.bytes)
      vertexes.push(decodeVertex(field.bytes));
    else if (field.no === FIELD.status.logs && field.bytes)
      logs.push(decodeLog(field.bytes));
    else if (field.no === FIELD.status.warnings && field.bytes)
      warnings.push(decodeWarning(field.bytes));
  return { vertexes, logs, warnings };
};

/**
 * Render BuildKit trace records as `docker build --progress=plain` does:
 * a `#<step> <name>` header per build step, `#<step> <line>` for its output,
 * and `#<step> ERROR: ...` when it fails.
 *
 * Stateful across records: step numbers, already-printed headers and
 * not-yet-terminated log lines all carry over.
 */
const buildkitLog = (onText: (text: string) => void) => {
  const steps = new Map<string, number>();
  const headed = new Set<string>();
  const cached = new Set<string>();
  /** Trailing output of each step that hasn't reached a newline yet. */
  const partial = new Map<string, string>();

  /** Step numbers follow the order vertices first appear, as BuildKit's do. */
  const step = (digest: string) => {
    let number = steps.get(digest);
    if (number === undefined) steps.set(digest, (number = steps.size + 1));
    return number;
  };

  /** Emit one line, tagged with the step it belongs to: `#3 <line>`. */
  const write = (number: number, line: string) =>
    onText(`#${number} ${line}\n`);

  return {
    /** Decode one `moby.buildkit.trace` payload; returns any step errors. */
    record: (aux: string): string[] => {
      const { vertexes, logs, warnings } = decodeStatus(
        Buffer.from(aux, "base64"),
      );
      const errors: string[] = [];

      for (const vertex of vertexes) {
        const number = step(vertex.digest);
        // Vertices are re-sent on every state change, so print names once.
        if (vertex.name && !headed.has(vertex.digest)) {
          headed.add(vertex.digest);
          write(number, vertex.name);
        }
        if (vertex.cached && vertex.completed && !cached.has(vertex.digest)) {
          cached.add(vertex.digest);
          write(number, "CACHED");
        }
        if (vertex.error) {
          write(number, `ERROR: ${vertex.error}`);
          errors.push(vertex.error);
        }
      }

      for (const log of logs) {
        const number = step(log.vertex);
        const lines = ((partial.get(log.vertex) ?? "") + log.text).split("\n");
        partial.set(log.vertex, lines.pop()!);
        for (const line of lines) write(number, line);
      }

      for (const warning of warnings) onText(`WARNING: ${warning}\n`);

      return errors;
    },

    /** Emit output that never reached a trailing newline. */
    flush: () => {
      for (const [vertex, trailing] of partial)
        if (trailing) write(step(vertex), trailing);
      partial.clear();
    },
  };
};

// ---------------------------------------------------------------------------
// followProgress
// ---------------------------------------------------------------------------

/** Why a build or pull failed. */
export type Failure = {
  /** The daemon's message, or the error that cut the stream short. */
  message: string;
  /** Exit code of the failing step, when the daemon reports one. */
  code?: number;
};

type JsonMessage = {
  stream?: string;
  error?: string;
  errorDetail?: { code?: number; message?: string };
  id?: string;
  /** A base64 protobuf for trace records; an object (e.g. `{ ID }`) otherwise. */
  aux?: unknown;
};

const TRACE_ID = "moby.buildkit.trace";

/** BuildKit cancels the steps still running when one fails — not the cause. */
const CANCELLED = /context cancell?ed/i;

/**
 * Consume a Docker JSON progress stream, forwarding human-readable output to
 * `onText`.
 *
 * Resolves with the failure the daemon reported, or `undefined` if the stream
 * completed cleanly. Never rejects: a stream-level error is returned as a
 * {@link Failure} too, so output collected so far isn't thrown away.
 */
export const followProgress = (
  stream: NodeJS.ReadableStream,
  onText: (text: string) => void,
): Promise<Failure | undefined> =>
  new Promise((resolve) => {
    const buildkit = buildkitLog(onText);
    let failure: Failure | undefined;
    let pending = "";
    let settled = false;

    /** First failure wins, except that a real error supersedes a cancellation. */
    const fail = (next: Failure) => {
      if (
        !failure ||
        (CANCELLED.test(failure.message) && !CANCELLED.test(next.message))
      )
        failure = next;
    };

    const line = (raw: string) => {
      if (!raw.trim()) return;
      let event: JsonMessage;
      try {
        event = JSON.parse(raw);
      } catch {
        return; // the daemon only sends JSON; a partial line is not worth showing
      }

      if (event.stream) onText(event.stream);

      if (event.id === TRACE_ID && typeof event.aux === "string")
        for (const error of buildkit.record(event.aux))
          fail({ message: error });

      const error = event.error ?? event.errorDetail?.message;
      if (error) {
        // BuildKit repeats the failing step's error here; don't print it twice.
        if (error !== failure?.message) onText(`ERROR: ${error}\n`);
        fail({ message: error, code: event.errorDetail?.code });
      }
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      line(pending);
      buildkit.flush();
      resolve(failure);
    };

    stream.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    });
    stream.on("error", (error: Error) => {
      fail({ message: error.message });
      settle();
    });
    stream.on("end", settle);
    stream.on("close", settle);
  });
