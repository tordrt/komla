/**
 * The typed client, without a transport of its own and without Node APIs, so a sandboxed page or
 * the plugin host can use it over theirs (ADR 0008).
 */
import { KomlaError } from './errors.js';
import {
  KOMLA_CAPABILITIES,
  KOMLA_OPERATION_CAPABILITIES,
  KOMLA_OPERATION_TYPES,
  type KomlaCapability,
  type KomlaOperationRequest,
  type KomlaOperationResults,
  type KomlaOperationType,
} from './generated.js';

export * from './generated.js';
export { KomlaError } from './errors.js';

export interface KomlaCallOptions {
  /**
   * The id of the workspace to act on, in place of the calling one, as `--workspace` names it.
   * `workspace.list` lists the ids.
   */
  workspace?: string;
  signal?: AbortSignal;
}

/** Carries an operation request to Komla, and resolves to its result or throws a KomlaError. */
export interface KomlaTransport {
  send(request: KomlaOperationRequest, options: KomlaCallOptions): Promise<unknown>;
}

type RequestOf<T extends KomlaOperationType> = Extract<KomlaOperationRequest, { type: T }>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The values of a request field whose capability the client declared. */
type DeclaredValues<Capabilities extends Record<string, KomlaCapability>, C> = {
  [V in keyof Capabilities]: Capabilities[V] extends C ? V : never;
}[keyof Capabilities];

/** The requests of type T a client that declared C may send; never when it may send none. */
type DeclaredRequest<
  T extends KomlaOperationType,
  C,
> = (typeof KOMLA_OPERATION_CAPABILITIES)[T] extends infer Capability
  ? Capability extends null
    ? RequestOf<T>
    : Capability extends KomlaCapability
      ? Capability extends C
        ? RequestOf<T>
        : never
      : Capability extends {
            by: infer Field extends keyof RequestOf<T>;
            capabilities: infer Capabilities extends Record<string, KomlaCapability>;
          }
        ? [DeclaredValues<Capabilities, C>] extends [never]
          ? never
          : Simplify<
              Omit<RequestOf<T>, Field> & {
                [K in Field]: DeclaredValues<Capabilities, C> & RequestOf<T>[K];
              }
            >
        : never
  : never;

/** Every request a client that declared C may send. */
export type KomlaDeclaredRequest<C extends KomlaCapability> = {
  [T in KomlaOperationType]: DeclaredRequest<T, C>;
}[KomlaOperationType];

type Input<T extends KomlaOperationType, C> = Simplify<Omit<DeclaredRequest<T, C>, 'type'>>;

type Call<T extends KomlaOperationType, C> =
  Record<string, never> extends Input<T, C>
    ? (input?: Input<T, C>, options?: KomlaCallOptions) => Promise<KomlaOperationResults[T]>
    : (input: Input<T, C>, options?: KomlaCallOptions) => Promise<KomlaOperationResults[T]>;

type Namespace<T extends string> = T extends `${infer N}.${string}` ? N : never;

/**
 * One method for each operation the client may call, by its type: `komla.workspace.tag(…)` sends
 * `workspace.tag`. Operations whose capability the client didn't declare have no method.
 */
export type KomlaOperationMethods<C extends KomlaCapability> = {
  [N in Namespace<KomlaOperationType>]: {
    [T in KomlaOperationType as T extends `${N}.${infer Method}`
      ? [DeclaredRequest<T, C>] extends [never]
        ? never
        : Method
      : never]: Call<T, C>;
  };
};

export type KomlaClient<C extends KomlaCapability = never> = KomlaOperationMethods<C> & {
  /** The capabilities the client declared. */
  readonly capabilities: readonly C[];
  /** Sends an operation request as it is, for code that builds requests itself. */
  execute<R extends KomlaDeclaredRequest<C>>(
    request: R,
    options?: KomlaCallOptions
  ): Promise<KomlaOperationResults[R['type']]>;
};

export interface KomlaClientOptions<C extends KomlaCapability> {
  transport: KomlaTransport;
  /**
   * The capabilities the client uses beyond reading. It refuses operations that need any other,
   * so code that shows outside text, such as a pull request title, can't be turned into one that
   * launches an agent. Without any, the client can only read.
   */
  capabilities?: readonly C[];
}

/** The capability a request needs, if any, as Komla decides it. */
export function requiredCapability(request: KomlaOperationRequest): KomlaCapability | undefined {
  const capability = KOMLA_OPERATION_CAPABILITIES[request.type];
  if (capability === null || typeof capability === 'string') return capability ?? undefined;
  const value = (request as unknown as Record<string, unknown>)[capability.by];
  return typeof value === 'string' && Object.hasOwn(capability.capabilities, value)
    ? capability.capabilities[value as keyof typeof capability.capabilities]
    : undefined;
}

const KNOWN_CAPABILITIES = new Set<string>(KOMLA_CAPABILITIES.map(({ id }) => id));

export function createKomlaClient<const C extends KomlaCapability = never>(
  options: KomlaClientOptions<C>
): KomlaClient<C> {
  const capabilities = [...(options.capabilities ?? [])];
  const unknown = capabilities.filter((capability) => !KNOWN_CAPABILITIES.has(capability));
  if (unknown.length > 0) {
    throw new KomlaError(
      'INVALID_CAPABILITY',
      `Komla has no capability ${unknown.join(', ')}. It has ${[...KNOWN_CAPABILITIES].join(', ')}.`
    );
  }
  const declared = new Set<KomlaCapability>(capabilities);
  const { transport } = options;

  const execute = async (request: KomlaOperationRequest, callOptions: KomlaCallOptions = {}) => {
    const capability = requiredCapability(request);
    if (capability && !declared.has(capability)) {
      throw new KomlaError(
        'CAPABILITY_NOT_DECLARED',
        `${request.type} needs the ${capability} capability, which this client didn't declare.`,
        undefined,
        { capability }
      );
    }
    return transport.send(request, callOptions);
  };

  const methods: Record<string, Record<string, unknown>> = {};
  for (const type of KOMLA_OPERATION_TYPES) {
    const [namespace, method] = type.split('.') as [string, string];
    methods[namespace] ??= {};
    methods[namespace][method] = (input?: object, callOptions?: KomlaCallOptions) =>
      execute({ ...input, type } as KomlaOperationRequest, callOptions);
  }

  return Object.freeze({
    ...methods,
    capabilities: Object.freeze(capabilities),
    execute,
  }) as unknown as KomlaClient<C>;
}
