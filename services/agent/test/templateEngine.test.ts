import { describe, it, expect } from "vitest";

import {
  renderTemplate,
  renderTemplateDeep,
  TemplateError,
} from "../src/lib/templateEngine.js";

/**
 * Week-2b-runtime — template engine unit coverage.
 *
 *   [1] happy path — `{{ inputs.X }}` resolves with whitespace
 *       tolerance + partial replacement.
 *   [2] unknown key rejects — template missing in context → throws
 *       TemplateError.
 *   [3] non-`inputs.*` namespace rejects — only `inputs.*` accepted.
 *   [4] renderTemplateDeep — recursive walk over object/array with
 *       non-string primitives passing through.
 */

describe("renderTemplate — Week-2b-runtime", () => {
  it("[1] happy path — full and partial replacement + whitespace tolerance", () => {
    const ctx = { inputs: { email: "jane@example.com", ticket_id: "T-42" } };
    expect(renderTemplate("{{ inputs.email }}", ctx)).toBe("jane@example.com");
    expect(renderTemplate("{{inputs.email}}", ctx)).toBe("jane@example.com");
    expect(renderTemplate("/users/{{ inputs.email }}/reset", ctx)).toBe(
      "/users/jane@example.com/reset",
    );
    expect(renderTemplate("/tickets/{{inputs.ticket_id}}", ctx)).toBe(
      "/tickets/T-42",
    );
    // No-placeholder string passes through.
    expect(renderTemplate("/login", ctx)).toBe("/login");
  });

  it("[2] unknown key rejects with TemplateError citing available keys", () => {
    const ctx = { inputs: { email: "jane@example.com" } };
    expect(() => renderTemplate("{{ inputs.missing }}", ctx)).toThrow(
      TemplateError,
    );
    try {
      renderTemplate("{{ inputs.missing }}", ctx);
    } catch (err) {
      expect((err as TemplateError).message).toContain("missing");
      expect((err as TemplateError).message).toContain("email");
    }
  });

  it("[3] non-`inputs.*` namespace rejects", () => {
    const ctx = { inputs: { email: "a@b.c" } };
    expect(() => renderTemplate("{{ env.SECRET }}", ctx)).toThrow(TemplateError);
    expect(() => renderTemplate("{{ ticket.subject }}", ctx)).toThrow(
      TemplateError,
    );
  });

  it("[4] renderTemplateDeep — recursive walk + non-string passthrough", () => {
    const ctx = { inputs: { email: "jane@example.com", id: "T-42" } };
    const input = {
      url: "/tickets/{{ inputs.id }}",
      fields: [
        { name: "Email", value: "{{ inputs.email }}", required: true },
        { name: "Note", value: "literal text", required: false },
      ],
      retryCount: 3,
      optional: null,
    };
    const output = renderTemplateDeep(input, ctx);
    expect(output).toEqual({
      url: "/tickets/T-42",
      fields: [
        { name: "Email", value: "jane@example.com", required: true },
        { name: "Note", value: "literal text", required: false },
      ],
      retryCount: 3,
      optional: null,
    });
  });
});
