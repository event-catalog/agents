import {
  type Agent,
  type AgentInstanceHandle,
  type AgentReadOptions,
  defineTool,
  init,
  useAgentFinish,
  useDataWriter,
  useTool,
} from '@flue/runtime';
import * as v from 'valibot';

/**
 * A structured result an agent step must return. Each one becomes a `submit_<name>` tool on the
 * agent: the tool's input is the schema, so Flue validates the model's arguments (and lets it retry
 * on a mismatch) before anything is recorded.
 */
export type StructuredResult<TSchema extends v.ObjectSchema<v.ObjectEntries, undefined>> = {
  name: string;
  schema: TSchema;
  description: string;
};

type AnyStructuredResult = StructuredResult<v.ObjectSchema<v.ObjectEntries, undefined>>;

export const defineStructuredResult = <TSchema extends v.ObjectSchema<v.ObjectEntries, undefined>>(
  result: StructuredResult<TSchema>
): StructuredResult<TSchema> => result;

export const submitToolName = (result: AnyStructuredResult): string => `submit_${result.name}`;

/** Prompt suffix telling the model how to hand back a step's result. */
export const submitInstruction = (result: AnyStructuredResult): string =>
  `When you are done, call the \`${submitToolName(result)}\` tool exactly once with your result. Do not reply with the result as text.`;

/**
 * Agent hook: mounts a `submit_<name>` tool per result. A submit call writes the validated data onto
 * the reply (`reply.data[name]`) and ends the turn. If the model tries to finish without submitting,
 * it is sent back to do so (Flue caps this at 32 continuations, after which the run fails).
 */
export function useStructuredResults(results: readonly AnyStructuredResult[]): void {
  for (const result of results) {
    const write = useDataWriter(result.name, { schema: result.schema });
    useTool(
      defineTool({
        name: submitToolName(result),
        description: result.description,
        input: result.schema,
        run: ({ data }) => {
          write(data);
          return { output: 'Result recorded.', terminate: true };
        },
      })
    );
  }

  const submitTools = new Set(results.map(submitToolName));
  useAgentFinish(({ response, append }) => {
    if (response.toolCalls.some((call) => submitTools.has(call.tool) && !call.isError)) return;
    append({
      kind: 'signal',
      type: 'eventcatalog.result-required',
      body: `You have not submitted a result yet. Finish by calling the submit tool named in the request (one of: ${[...submitTools].join(', ')}).`,
    });
  });
}

/**
 * Workflow side: sends one step's prompt to the agent, waits for the response to settle, and returns
 * the result it submitted. Steps sent through the same handle share one conversation, so a later
 * step sees what earlier steps established (e.g. the apply step sees the planning step's research).
 */
export const promptForResult = async <TSchema extends v.ObjectSchema<v.ObjectEntries, undefined>>(
  agent: AgentInstanceHandle,
  prompt: string,
  result: StructuredResult<TSchema>,
  options?: AgentReadOptions
): Promise<v.InferOutput<TSchema>> => {
  const receipt = await agent.dispatch(`${prompt}\n\n${submitInstruction(result)}`);
  const reply = await agent.read(receipt, options);
  const submitted = reply.data[result.name]?.at(-1);

  if (submitted === undefined) {
    throw new Error(`The agent finished without calling ${submitToolName(result)}.`);
  }

  return v.parse(result.schema, submitted);
};

/**
 * `init()` for one review conversation. Every send carries `initialData` so whichever send creates
 * the instance seeds the agent's `useInitialData()` (Flue ignores it on later sends).
 */
export const initWithData = (agent: Agent, initialData: unknown): AgentInstanceHandle => {
  const handle = init(agent);
  return {
    id: handle.id,
    dispatch: (request) =>
      handle.dispatch(typeof request === 'string' ? { message: request, initialData } : { ...request, initialData }),
    read: (target, options) => handle.read(target, options),
    abort: () => handle.abort(),
  };
};
