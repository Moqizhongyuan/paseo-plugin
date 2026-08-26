import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readdir, readFile, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PromptSummary, PromptTemplate } from "./shared";

const storageDirectory = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugins",
  "paseo-plugin",
  "prompt-templates",
);

const promptFileId = /^[A-Za-z0-9_-]{1,100}$/;
const promptFilePattern = /^[A-Za-z0-9_-]{1,100}\.md$/;
const titleHeaderPattern = /^---\r?\ntitle:\s*(.*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

function normalizeTitle(title: string) {
  const normalized = title.trim();
  return normalized || "未命名提示词";
}

function previewFor(content: string) {
  const preview = content.replace(/\s+/g, " ").trim();
  return preview.slice(0, 160) || "空白提示词";
}

function filePathFor(id: string) {
  if (!promptFileId.test(id)) {
    throw new Error("Invalid prompt template id");
  }
  return join(storageDirectory, `${id}.md`);
}

function serializePrompt(title: string, content: string) {
  return `---\ntitle: ${JSON.stringify(normalizeTitle(title))}\n---\n${content}`;
}

function parsePrompt(id: string, raw: string, updatedAt: string): PromptTemplate {
  const match = raw.match(titleHeaderPattern);
  let title = "未命名提示词";
  let content = raw;

  if (match) {
    try {
      title = normalizeTitle(JSON.parse(match[1]) as string);
    } catch {
      title = normalizeTitle(match[1]);
    }
    content = match[2];
  }

  return {
    id,
    title,
    content,
    preview: previewFor(content),
    updatedAt,
  };
}

async function ensureStorageDirectory() {
  await mkdir(storageDirectory, { recursive: true });
}

async function readPrompt(id: string) {
  const path = filePathFor(id);
  const [raw, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return parsePrompt(id, raw, metadata.mtime.toISOString());
}

export async function listPromptTemplates(): Promise<{ items: PromptSummary[] }> {
  await ensureStorageDirectory();
  const entries = await readdir(storageDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && promptFilePattern.test(entry.name));
  const items = await Promise.all(
    files.map(async (entry) => {
      const id = entry.name.slice(0, -3);
      return readPrompt(id);
    }),
  );

  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    items: items.map(({ content: _content, ...summary }) => summary),
  };
}

export async function getPromptTemplate(input: { id: string }) {
  return readPrompt(input.id);
}

export async function createPromptTemplate(input: { title: string; content: string }) {
  await ensureStorageDirectory();
  const id = randomUUID();
  await writeFile(filePathFor(id), serializePrompt(input.title, input.content), "utf8");
  return readPrompt(id);
}

export async function updatePromptTemplate(input: { id: string; title: string; content: string }) {
  await writeFile(filePathFor(input.id), serializePrompt(input.title, input.content), "utf8");
  return readPrompt(input.id);
}

export async function deletePromptTemplate(input: { id: string }) {
  await unlink(filePathFor(input.id));
  return { deleted: true };
}
