// Layer 1 memory store: structured YAML user preference cards with scope, backstory, provenance,
// <user_profile> token-budget compilation, and tiered draft/branch proposal approval.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { estimateTextTokens } from "../context/token-estimator.ts";

export type ProfileStatus = "active" | "superseded" | "deprecated";
export type ProfileConfidence = "confirmed" | "inferred";

export interface ProfileEvidenceRef {
	session: string;
	turn: number;
}

export interface ProfileCard {
	id: string;
	category: string;
	key: string;
	value: string;
	scope: string;
	status: ProfileStatus;
	confidence: ProfileConfidence;
	backstory: string;
	evidence_refs: ProfileEvidenceRef[];
	created_at: string;
	updated_at: string;
}

export interface ProfileCardFilter {
	status?: ProfileStatus;
	confidence?: ProfileConfidence;
	categoryPrefix?: string;
}

export interface ProfileUpdateProposal {
	card: ProfileCard;
	proposalPath: string;
	branchName?: string;
	previousCard?: ProfileCard;
	requiresApproval: true;
}

export class ProfileValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileValidationError";
	}
}

const VALID_STATUSES: readonly ProfileStatus[] = ["active", "superseded", "deprecated"];
const VALID_CONFIDENCES: readonly ProfileConfidence[] = ["confirmed", "inferred"];
const DEFAULT_PROFILE_TOKEN_BUDGET = 1500;

/** Validate an untrusted parsed YAML object against the Layer 1 ProfileCard schema. */
export function validateProfileCard(raw: unknown, sourceLabel = "profile card"): ProfileCard {
	if (!isPlainRecord(raw)) {
		throw new ProfileValidationError(`${sourceLabel} must be a YAML mapping object.`);
	}

	const id = requireNonEmptyString(raw.id, `${sourceLabel}.id`);
	const category = requireNonEmptyString(raw.category, `${sourceLabel}.category`);
	const key = requireNonEmptyString(raw.key, `${sourceLabel}.key`);
	const value = requireNonEmptyString(raw.value, `${sourceLabel}.value`);
	const scope = requireNonEmptyString(raw.scope, `${sourceLabel}.scope`);
	const backstory = requireNonEmptyString(raw.backstory, `${sourceLabel}.backstory`);
	const created_at = requireNonEmptyString(raw.created_at, `${sourceLabel}.created_at`);
	const updated_at = requireNonEmptyString(raw.updated_at, `${sourceLabel}.updated_at`);

	if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status as ProfileStatus)) {
		throw new ProfileValidationError(
			`${sourceLabel}.status must be one of ${VALID_STATUSES.join(", ")}, got "${String(raw.status)}".`,
		);
	}
	if (typeof raw.confidence !== "string" || !VALID_CONFIDENCES.includes(raw.confidence as ProfileConfidence)) {
		throw new ProfileValidationError(
			`${sourceLabel}.confidence must be one of ${VALID_CONFIDENCES.join(", ")}, got "${String(raw.confidence)}".`,
		);
	}

	if (!Array.isArray(raw.evidence_refs) || raw.evidence_refs.length === 0) {
		throw new ProfileValidationError(`${sourceLabel}.evidence_refs must be a non-empty array.`);
	}
	const evidence_refs: ProfileEvidenceRef[] = raw.evidence_refs.map((entry, idx) => {
		if (!isPlainRecord(entry)) {
			throw new ProfileValidationError(`${sourceLabel}.evidence_refs[${idx}] must be an object.`);
		}
		const session = requireNonEmptyString(entry.session, `${sourceLabel}.evidence_refs[${idx}].session`);
		if (typeof entry.turn !== "number" || !Number.isInteger(entry.turn) || entry.turn < 0) {
			throw new ProfileValidationError(`${sourceLabel}.evidence_refs[${idx}].turn must be a non-negative integer.`);
		}
		return { session, turn: entry.turn };
	});

	return {
		id,
		category,
		key,
		value,
		scope,
		status: raw.status as ProfileStatus,
		confidence: raw.confidence as ProfileConfidence,
		backstory,
		evidence_refs,
		created_at,
		updated_at,
	};
}

/** Layer 1 YAML profile card store under knowledge/memory/profile/. */
export class ProfileStore {
	private readonly profileDir: string;
	private readonly knowledgeDir: string;

	constructor(profileDir: string, knowledgeDir?: string) {
		this.profileDir = profileDir;
		this.knowledgeDir = knowledgeDir ?? join(profileDir, "..", "..");
	}

	/** Load and strictly validate all YAML profile cards matching an optional filter. */
	listCards(filter?: ProfileCardFilter): ProfileCard[] {
		if (!existsSync(this.profileDir)) return [];

		const files = readdirSync(this.profileDir)
			.filter((name) => (name.endsWith(".yaml") || name.endsWith(".yml")) && !name.startsWith("."))
			.sort((a, b) => a.localeCompare(b));

		const cards: ProfileCard[] = [];
		for (const file of files) {
			const fullPath = join(this.profileDir, file);
			const parsed: unknown = parseYaml(readFileSync(fullPath, "utf8"));
			const entries = Array.isArray(parsed) ? parsed : [parsed];
			for (let i = 0; i < entries.length; i++) {
				const card = validateProfileCard(entries[i], `${file}[${i}]`);
				if (matchesFilter(card, filter)) {
					cards.push(card);
				}
			}
		}

		cards.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
		return cards;
	}

	/** Retrieve a single validated profile card by ID. */
	getCard(id: string): ProfileCard | undefined {
		return this.listCards().find((card) => card.id === id);
	}

	/**
	 * Compile active, confirmed profile cards into a deterministic <user_profile> block
	 * bounded by maxTokens (default 1500 tokens, fitting the 1-2K static prefix budget).
	 */
	compileUserProfile(maxTokens = DEFAULT_PROFILE_TOKEN_BUDGET): string {
		const cards = this.listCards({ status: "active", confidence: "confirmed" });
		if (cards.length === 0) return "";

		const header =
			"以下是经用户确认的长期偏好卡片（仅在各自 scope 范围内生效；若与本轮显式指令冲突，以本轮指令为准）：";
		const lines: string[] = [header];
		let usedTokens = estimateTextTokens(header);

		for (const card of cards) {
			const line = `- [${card.category}/${card.key}] ${card.value} (适用范围: ${card.scope})`;
			const lineTokens = estimateTextTokens(line);
			if (usedTokens + lineTokens > maxTokens) {
				break;
			}
			lines.push(line);
			usedTokens += lineTokens;
		}

		return lines.length > 1 ? lines.join("\n") : "";
	}

	/**
	 * Tiered update proposal: never silently overwrite main branch Layer 1 preferences.
	 * Writes the proposed YAML card into .drafts/ (and optionally creates a Git proposal branch).
	 */
	proposeCardUpdate(rawCard: ProfileCard, options?: { createGitBranch?: boolean }): ProfileUpdateProposal {
		const card = validateProfileCard(rawCard, `proposal:${rawCard.id}`);
		const previousCard = this.getCard(card.id);
		const draftsDir = join(this.profileDir, ".drafts");
		mkdirSync(draftsDir, { recursive: true });

		const safeId = sanitizeFilename(card.id);
		const proposalPath = join(draftsDir, `${safeId}.proposal.yaml`);
		writeFileSync(proposalPath, stringifyYaml(card), "utf8");

		let branchName: string | undefined;
		if (options?.createGitBranch && existsSync(join(this.knowledgeDir, ".git"))) {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			branchName = `assistant/profile-${safeId}-${stamp}`;
			try {
				execFileSync("git", ["branch", branchName], {
					cwd: this.knowledgeDir,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch {
				branchName = undefined;
			}
		}

		return {
			card,
			proposalPath,
			branchName,
			previousCard,
			requiresApproval: true,
		};
	}

	/** Persist an explicitly human-approved profile card into knowledge/memory/profile/<id>.yaml. */
	applyApprovedCard(rawCard: ProfileCard): string {
		const card = validateProfileCard(rawCard, `approved:${rawCard.id}`);
		mkdirSync(this.profileDir, { recursive: true });
		const targetPath = join(this.profileDir, `${sanitizeFilename(card.id)}.yaml`);
		writeFileSync(targetPath, stringifyYaml(card), "utf8");
		return targetPath;
	}
}

function matchesFilter(card: ProfileCard, filter: ProfileCardFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.status && card.status !== filter.status) return false;
	if (filter.confidence && card.confidence !== filter.confidence) return false;
	if (filter.categoryPrefix && !card.category.startsWith(filter.categoryPrefix)) return false;
	return true;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProfileValidationError(`${field} must be a non-empty string.`);
	}
	return value.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFilename(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "card";
}
