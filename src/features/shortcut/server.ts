import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import {
  getCurrentBranch as getCurrentBranchContract,
  getShortcutBinding as getShortcutBindingContract,
  saveShortcutBinding as saveShortcutBindingContract,
} from "./shared";

const execFileAsync = promisify(execFile);
const storageDirectory = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugins",
  "paseo-plugin",
);
const storageFile = join(storageDirectory, "shortcut-bindings.json");

interface ShortcutBinding {
  branch?: string;
  mrUrl?: string;
  meegoUrl?: string;
}

type ShortcutBindings = Record<string, ShortcutBinding>;
type GetShortcutBindingInput = z.infer<typeof getShortcutBindingContract.input>;
type SaveShortcutBindingInput = z.infer<typeof saveShortcutBindingContract.input>;
type GetCurrentBranchInput = z.infer<typeof getCurrentBranchContract.input>;

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeBinding(value: unknown): ShortcutBinding | null {
  if (typeof value === "string") {
    const branch = value.trim();
    return branch ? { branch } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const branch =
    typeof record.branch === "string" && record.branch.trim() ? record.branch.trim() : undefined;
  const mrUrl =
    typeof record.mrUrl === "string" && record.mrUrl.trim() ? record.mrUrl.trim() : undefined;
  const meegoUrl =
    typeof record.meegoUrl === "string" && record.meegoUrl.trim()
      ? record.meegoUrl.trim()
      : undefined;

  return branch || mrUrl || meegoUrl ? { branch, mrUrl, meegoUrl } : null;
}

async function readBindings(): Promise<ShortcutBindings> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const bindings: ShortcutBindings = {};
    for (const [key, value] of Object.entries(parsed)) {
      const binding = key.trim() ? normalizeBinding(value) : null;
      if (binding) bindings[key] = binding;
    }
    return bindings;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

async function writeBindings(bindings: ShortcutBindings) {
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(storageFile, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
}

export async function getShortcutBinding({ agentId }: GetShortcutBindingInput) {
  const bindings = await readBindings();
  const binding = bindings[agentId];
  return {
    branch: binding?.branch ?? null,
    mrUrl: binding?.mrUrl ?? null,
    meegoUrl: binding?.meegoUrl ?? null,
  };
}

export async function saveShortcutBinding({
  agentId,
  branch,
  mrUrl,
  meegoUrl,
}: SaveShortcutBindingInput) {
  const bindings = await readBindings();
  const normalizedBranch = branch.trim();
  const normalizedMrUrl = mrUrl.trim();
  const normalizedMeegoUrl = meegoUrl.trim();
  bindings[agentId] = {
    branch: normalizedBranch,
    mrUrl: normalizedMrUrl,
    meegoUrl: normalizedMeegoUrl,
  };
  await writeBindings(bindings);
  return {
    branch: normalizedBranch,
    mrUrl: normalizedMrUrl,
    meegoUrl: normalizedMeegoUrl,
  };
}

export async function getCurrentBranchHandler({ directory }: GetCurrentBranchInput) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "branch", "--show-current"], {
      encoding: "utf8",
    });
    const currentBranch = stdout.trim();
    return { branch: currentBranch || null };
  } catch {
    return { branch: null };
  }
}
