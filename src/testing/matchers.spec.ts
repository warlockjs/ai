import { describe, expect, it } from "vitest";
import { schema } from "../workflow/_test-helpers";
import { mockAgent } from "../mock/mock-agent";
import { mockRouter } from "../mock/mock-router";
import { END } from "../contracts/end.type";
import { buildScriptedAgent } from "../supervisor/_test-helpers";
import { supervisor } from "../supervisor/supervisor";
import { step } from "../workflow/step";
import { workflow } from "../workflow/workflow";
import { registerAiMatchers } from "./matchers";

registerAiMatchers();

function scripted(name: string) {
  return buildScriptedAgent({
    name,
    description: `${name} agent`,
    responses: [{ content: `${name}-out`, finishReason: "stop" }],
  });
}

describe("toRouteTo", () => {
  it("passes when the supervisor dispatched the intent", async () => {
    const sup = supervisor({
      name: "rt",
      intents: { writer: scripted("writer"), critic: scripted("critic") },
      route: mockRouter(["writer", "critic", END]),
    });

    const result = await sup.execute("go");

    expect(result).toRouteTo("writer");
    expect(result).toRouteTo("critic");
  });

  it("fails when the supervisor never dispatched the intent", async () => {
    const sup = supervisor({
      name: "rt",
      intents: { writer: scripted("writer"), critic: scripted("critic") },
      route: mockRouter(["writer", END]),
    });

    const result = await sup.execute("go");

    expect(result).not.toRouteTo("critic");
  });

  it("fails on a non-supervisor result", async () => {
    const result = await mockAgent({ name: "a", responses: [{ content: "x" }] }).execute("hi");

    expect(result).not.toRouteTo("anything");
  });
});

describe("toConverge", () => {
  it("passes when the supervisor terminates cleanly", async () => {
    const sup = supervisor({
      name: "conv",
      intents: { writer: scripted("writer") },
      route: mockRouter(["writer", END]),
    });

    const result = await sup.execute("go");

    expect(result).toConverge();
  });

  it("fails when the supervisor hits the iteration cap", async () => {
    const sup = supervisor({
      name: "loop",
      intents: { writer: scripted("writer") },
      route: mockRouter(["writer"], { onExhausted: "repeat" }),
      maxIterations: 2,
    });

    const result = await sup.execute("go");

    expect(result).not.toConverge();
  });
});

describe("toPassStep", () => {
  it("passes when the named step completed", async () => {
    const wf = workflow({
      name: "wf",
      steps: [step({ name: "draft", run: () => "done" })],
    });

    const result = await wf.execute({});

    expect(result).toPassStep("draft");
  });

  it("fails on an unknown step name", async () => {
    const wf = workflow({
      name: "wf",
      steps: [step({ name: "draft", run: () => "done" })],
    });

    const result = await wf.execute({});

    expect(result).not.toPassStep("missing");
  });

  it("fails on a non-workflow result", async () => {
    const result = await mockAgent({ name: "a", responses: [{ content: "x" }] }).execute("hi");

    expect(result).not.toPassStep("draft");
  });
});

describe("toOutputShape", () => {
  const shape = schema<{ city: string }>((value) => {
    if (value && typeof value === "object" && typeof (value as { city?: unknown }).city === "string") {
      return { value: value as { city: string } };
    }
    return { issues: [{ message: "expected { city: string }" }] };
  });

  it("passes when result.data matches the schema", async () => {
    const subject = mockAgent<{ city: string }>({
      name: "geo",
      responses: [{ content: '{ "city": "Cairo" }', finishReason: "stop" }],
    });

    const result = await subject.execute("?", { output: shape });

    expect(result).toOutputShape(shape);
  });

  it("fails when result.data is missing", async () => {
    const subject = mockAgent({ name: "geo", responses: [{ content: "plain text" }] });

    const result = await subject.execute("?");

    expect(result).not.toOutputShape(shape);
  });
});
