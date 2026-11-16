import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
  principalPermissionGrants,
  projectCategories,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PER_BUCKET = 4;

describeEmbeddedPostgres("artifacts under project visibility (WIR-1272)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifacts-project-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "enforce");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(projectCategories);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function actorFor(companyId: string, userId: string, membershipRole: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole }],
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api/companies", companyRoutes(db, {} as never));
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: `Artifacts visibility ${randomUUID()}`,
      issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [sales] = await db.insert(projectCategories).values({ companyId, name: "Sales" }).returning();
    const [delivery] = await db.insert(projectCategories).values({ companyId, name: "Delivery" }).returning();
    const [salesProject] = await db.insert(projects).values({ companyId, name: "Sales project", categoryId: sales!.id }).returning();
    const [deliveryProject] = await db.insert(projects).values({ companyId, name: "Delivery project", categoryId: delivery!.id }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer" }).returning();

    const ownerId = `user-${randomUUID()}`;
    const salesOperatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: salesOperatorId, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: salesOperatorId,
      permissionKey: "projects:access",
      scope: { categoryIds: [sales!.id] },
      grantedByUserId: null,
    });

    const projectIds = {
      sales: salesProject!.id,
      delivery: deliveryProject!.id,
      unbound: null,
    } as const;
    const issueByBucket = {} as Record<keyof typeof projectIds, typeof issues.$inferSelect>;
    for (const bucket of Object.keys(projectIds) as Array<keyof typeof projectIds>) {
      const [issue] = await db.insert(issues).values({
        companyId,
        title: `${bucket} issue`,
        status: "todo",
        priority: "medium",
        projectId: projectIds[bucket],
      }).returning();
      issueByBucket[bucket] = issue!;
    }

    // Interleave updatedAt across buckets so every unfiltered page mixes them.
    const docIdsByBucket: Record<keyof typeof projectIds, string[]> = { sales: [], delivery: [], unbound: [] };
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const buckets = Object.keys(projectIds) as Array<keyof typeof projectIds>;
    for (let index = 0; index < PER_BUCKET * buckets.length; index += 1) {
      const bucket = buckets[index % buckets.length]!;
      const [document] = await db.insert(documents).values({
        companyId,
        title: `${bucket} doc ${index}`,
        latestBody: `${bucket} body ${index}`,
        format: "markdown",
        createdByAgentId: agent!.id,
        updatedAt: new Date(base + index * 60_000),
      }).returning();
      await db.insert(issueDocuments).values({
        companyId,
        issueId: issueByBucket[bucket].id,
        documentId: document!.id,
        key: `doc-${index}`,
      });
      docIdsByBucket[bucket].push(document!.id);
    }

    return {
      companyId,
      owner: actorFor(companyId, ownerId, "owner"),
      salesOperator: actorFor(companyId, salesOperatorId, "operator"),
      issueByBucket,
      docIdsByBucket,
      deliveryProjectId: deliveryProject!.id,
    };
  }

  const artifactIds = (ids: string[]) => ids.map((id) => `document:${id}`);

  async function listAll(actor: Express.Request["actor"], companyId: string, limit: number) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await request(app(actor)).get(`/api/companies/${companyId}/artifacts?${query}`).expect(200);
      pages += 1;
      ids.push(...res.body.artifacts.map((artifact: { id: string }) => artifact.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    return { ids, pages };
  }

  it("omits a Delivery-owned document from the list for a Sales-only operator and keeps Sales and unbound ones", async () => {
    const fixture = await seed();
    const { ids } = await listAll(fixture.salesOperator, fixture.companyId, 50);

    expect(new Set(ids)).toEqual(new Set(artifactIds([...fixture.docIdsByBucket.sales, ...fixture.docIdsByBucket.unbound])));
    expect(ids).toHaveLength(PER_BUCKET * 2);
  });

  it("paginates over visible documents with no gaps, duplicates or Delivery rows", async () => {
    const fixture = await seed();
    const { ids, pages } = await listAll(fixture.salesOperator, fixture.companyId, 3);

    expect(pages).toBe(Math.ceil((PER_BUCKET * 2) / 3));
    expect(ids).toHaveLength(new Set(ids).size);
    expect(new Set(ids)).toEqual(new Set(artifactIds([...fixture.docIdsByBucket.sales, ...fixture.docIdsByBucket.unbound])));
  });

  it("returns no cursor on a page that exactly exhausts the visible documents", async () => {
    const fixture = await seed();
    const res = await request(app(fixture.salesOperator))
      .get(`/api/companies/${fixture.companyId}/artifacts?limit=${PER_BUCKET * 2}`)
      .expect(200);

    expect(res.body.artifacts).toHaveLength(PER_BUCKET * 2);
    expect(res.body.nextCursor).toBeNull();
  });

  it("answers a hidden project filter with an empty list, not the project's documents", async () => {
    const fixture = await seed();
    const res = await request(app(fixture.salesOperator))
      .get(`/api/companies/${fixture.companyId}/artifacts?projectId=${fixture.deliveryProjectId}`)
      .expect(200);

    expect(res.body.artifacts).toEqual([]);
  });

  it("leaves owner results identical to the unfiltered baseline", async () => {
    const fixture = await seed();
    const enforced = await listAll(fixture.owner, fixture.companyId, 50);
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const baseline = await listAll(fixture.owner, fixture.companyId, 50);

    expect(enforced.ids).toHaveLength(PER_BUCKET * 3);
    expect(enforced.ids).toEqual(baseline.ids);
  });

  it("filters nothing when the access mode is off", async () => {
    const fixture = await seed();
    vi.stubEnv("PAPERCLIP_PROJECT_ACCESS_MODE", "off");
    const { ids } = await listAll(fixture.salesOperator, fixture.companyId, 50);

    expect(ids).toHaveLength(PER_BUCKET * 3);
  });

  it("does not name a hidden root issue as a parent_task group title", async () => {
    const fixture = await seed();
    const hiddenRoot = fixture.issueByBucket.delivery;
    const salesIssue = fixture.issueByBucket.sales;
    await db.update(issues).set({ parentId: hiddenRoot.id }).where(eq(issues.id, salesIssue.id));

    const operator = await request(app(fixture.salesOperator))
      .get(`/api/companies/${fixture.companyId}/artifacts?groupBy=parent_task&limit=50`)
      .expect(200);
    expect(JSON.stringify(operator.body)).not.toContain(hiddenRoot.title);
    expect(operator.body.groups.map((group: { issue: { id: string } }) => group.issue.id)).toContain(salesIssue.id);

    const owner = await request(app(fixture.owner))
      .get(`/api/companies/${fixture.companyId}/artifacts?groupBy=parent_task&limit=50`)
      .expect(200);
    expect(owner.body.groups.map((group: { issue: { id: string } }) => group.issue.id)).toContain(hiddenRoot.id);
  });

  describe("direct reads of a Delivery-owned document", () => {
    const probes: Array<{ name: string; path: (issueId: string, key: string) => string }> = [
      { name: "list", path: (issueId) => `/api/issues/${issueId}/documents` },
      { name: "by key", path: (issueId, key) => `/api/issues/${issueId}/documents/${key}` },
      { name: "revisions", path: (issueId, key) => `/api/issues/${issueId}/documents/${key}/revisions` },
      { name: "annotations", path: (issueId, key) => `/api/issues/${issueId}/documents/${key}/annotations` },
    ];

    for (const { name, path } of probes) {
      it(`${name}: Sales-only operator gets the random-id 404 byte for byte`, async () => {
        const fixture = await seed();
        const key = "doc-1";
        const operator = request(app(fixture.salesOperator));
        const hidden = await operator.get(path(fixture.issueByBucket.delivery.id, key));
        const random = await operator.get(path(randomUUID(), key));

        expect(random.status).toBe(404);
        expect(hidden.status).toBe(404);
        expect(hidden.text).toBe(random.text);
      });
    }

    it("still reads Sales-owned and unbound documents, and the owner reads Delivery's", async () => {
      const fixture = await seed();
      const operator = request(app(fixture.salesOperator));
      await operator.get(`/api/issues/${fixture.issueByBucket.sales.id}/documents/doc-0`).expect(200);
      await operator.get(`/api/issues/${fixture.issueByBucket.unbound.id}/documents/doc-2`).expect(200);
      await request(app(fixture.owner))
        .get(`/api/issues/${fixture.issueByBucket.delivery.id}/documents/doc-1`)
        .expect(200);
    });
  });
});
