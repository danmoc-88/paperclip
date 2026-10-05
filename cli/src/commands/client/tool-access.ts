import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { createToolProfileEntryForProfileSchema, createToolProfileBindingForProfileSchema, unbindToolProfileBindingSchema, putToolConnectionInstallsSchema } from "@paperclipai/shared";
import { addCommonClientOptions, apiPath, handleCommandError, printOutput, resolveCommandContext, type BaseClientOptions } from "./common.js";

interface Options extends BaseClientOptions {
  companyId?: string;
  file?: string;
}

/** Operator commands use the normal client authentication and server board guards. */
export function registerToolAccessCommands(program: Command): void {
  const access = program.command("tool-access").description("Operator snapshots and connection installation lists");

  addCommonClientOptions(access.command("snapshot")
    .description("Read installation, catalog, profile, policy and effective-access rows as JSON (no credentials)")
    .option("-C, --company-id <id>", "Company ID")
    .action(async (opts: Options) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const startedAt = new Date().toISOString();
        const companyPath = apiPath`/api/companies/${ctx.companyId}`;
        const connections = await ctx.api.get<{ connections: Array<{ id: string; name: string; connectionPurpose: string }> }>(`${companyPath}/tools/connections`);
        const agents = await ctx.api.get<Array<{ id: string; name: string; status: string }>>(`${companyPath}/agents`);
        if (!connections || !agents) throw new Error("Incomplete snapshot: missing connections or agents");
        const profiles = await ctx.api.get(`${companyPath}/tools/profiles`);
        const policies = await ctx.api.get(`${companyPath}/tools/policies`);
        if (!profiles || !policies) throw new Error("Incomplete snapshot: missing profiles or policies");
        const connectionRows = [];
        for (const connection of connections.connections) {
          // Do not export connection configuration, secrets, grants or tokens.
          if (connection.connectionPurpose === "ai") continue;
          const installs = await ctx.api.get(apiPath`/api/tool-connections/${connection.id}/installs`);
          const catalog = await ctx.api.get(apiPath`/api/tool-connections/${connection.id}/catalog`);
          if (!installs || !catalog) throw new Error(`Incomplete snapshot for connection ${connection.id}`);
          connectionRows.push({ id: connection.id, name: connection.name, installs, catalog });
        }
        const effectiveAccess = [];
        for (const agent of agents) {
          const effective = await ctx.api.get(`${companyPath}/tools/profiles/effective/agents/${encodeURIComponent(agent.id)}`);
          if (!effective) throw new Error(`Incomplete snapshot for agent ${agent.id}`);
          effectiveAccess.push({ agentId: agent.id, name: agent.name, status: agent.status, effective });
        }
        printOutput({ companyId: ctx.companyId, startedAt, completedAt: new Date().toISOString(), connections: connectionRows, profiles, policies, effectiveAccess }, { json: true });
      } catch (err) { handleCommandError(err); }
    }));

  addCommonClientOptions(access.command("installs:get")
    .description("Read the full installation list for one connection")
    .argument("<connectionId>")
    .action(async (connectionId: string, opts: Options) => {
      try {
        const ctx = resolveCommandContext(opts);
        printOutput(await ctx.api.get(apiPath`/api/tool-connections/${connectionId}/installs`), { json: true });
      } catch (err) { handleCommandError(err); }
    }));

  addCommonClientOptions(access.command("installs:set")
    .description("Replace one connection's installation list from a reviewed JSON file; may change access bindings")
    .argument("<connectionId>")
    .requiredOption("--file <path>", "JSON file with the complete {installs:[{targetType,targetId}]} payload")
    .action(async (connectionId: string, opts: Options) => {
      try {
        const payload = putToolConnectionInstallsSchema.parse(JSON.parse(await readFile(opts.file!, "utf8")));
        const ctx = resolveCommandContext(opts);
        const result = await ctx.api.put(apiPath`/api/tool-connections/${connectionId}/installs`, payload);
        printOutput(result, { json: true });
      } catch (err) { handleCommandError(err); }
    }));

  // These existing profile operations are needed to restore legacy entries and
  // custom install bindings. They do not bypass the server's mutation guards.
  for (const operation of ["entry:add", "binding:bind", "binding:unbind"] as const) {
    addCommonClientOptions(access.command(operation)
      .description("Restore reviewed profile data from a JSON file using the existing access API")
      .argument("<profileId>")
      .option("-C, --company-id <id>", "Company ID (required for bindings)")
      .requiredOption("--file <path>", "Reviewed API payload JSON file")
      .action(async (profileId: string, opts: Options) => {
        try {
          const input: unknown = JSON.parse(await readFile(opts.file!, "utf8"));
          const schema = operation === "entry:add" ? createToolProfileEntryForProfileSchema
            : operation === "binding:bind" ? createToolProfileBindingForProfileSchema : unbindToolProfileBindingSchema;
          const payload = schema.parse(input);
          const ctx = resolveCommandContext(opts, { requireCompany: operation !== "entry:add" });
          const endpoint = operation === "entry:add" ? apiPath`/api/tool-profiles/${profileId}/entries`
            : `${apiPath`/api/companies/${ctx.companyId}/tools/profiles/${profileId}`}/${operation === "binding:bind" ? "bind" : "unbind"}`;
          printOutput(await ctx.api.post(endpoint, payload), { json: true });
        } catch (err) { handleCommandError(err); }
      }));
  }

  addCommonClientOptions(access.command("entry:remove")
    .description("Remove a confirmed duplicate profile entry by ID during rollback")
    .argument("<entryId>")
    .action(async (entryId: string, opts: Options) => {
      try {
        const ctx = resolveCommandContext(opts);
        printOutput(await ctx.api.delete(apiPath`/api/tool-profile-entries/${entryId}`), { json: true });
      } catch (err) { handleCommandError(err); }
    }));
}
