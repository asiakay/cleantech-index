// Query-layer tests for all user-data DB functions (bookmarks, watchlists, notes, filters).
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertUser } from "../src/auth.js";
import {
  toggleBookmark,
  isBookmarked,
  getUserBookmarks,
  getUserWatchlists,
  getWatchlistItems,
  createWatchlist,
  deleteWatchlist,
  toggleWatchlistItem,
  saveNote,
  getNote,
  getUserNotes,
  saveFilter,
  deleteFilter,
  getUserFilters,
  getDashboardData,
} from "../src/db.js";

// Seeded project slugs we can use for foreign-key operations.
const SLUG_A = "mustang-ridge-solar";
const SLUG_B = "llano-battery-hub";

let uid; // fresh user per describe block

async function freshUser(prefix) {
  return upsertUser(env, `${prefix}-${Date.now()}@test.com`);
}

describe("bookmarks", () => {
  beforeEach(async () => { uid = await freshUser("bm"); });

  it("toggleBookmark adds then removes a bookmark", async () => {
    expect(await toggleBookmark(env, uid, SLUG_A)).toBe(true);  // added
    expect(await toggleBookmark(env, uid, SLUG_A)).toBe(false); // removed
  });

  it("isBookmarked reflects toggle state", async () => {
    expect(await isBookmarked(env, uid, SLUG_A)).toBe(false);
    await toggleBookmark(env, uid, SLUG_A);
    expect(await isBookmarked(env, uid, SLUG_A)).toBe(true);
  });

  it("getUserBookmarks returns all bookmarks with project metadata", async () => {
    await toggleBookmark(env, uid, SLUG_A);
    await toggleBookmark(env, uid, SLUG_B);
    const rows = await getUserBookmarks(env, uid);
    expect(rows.length).toBe(2);
    const slugs = rows.map((r) => r.project_slug);
    expect(slugs).toContain(SLUG_A);
    expect(slugs).toContain(SLUG_B);
    // Joined metadata present
    expect(rows.find((r) => r.project_slug === SLUG_A).project_name).toBe("Mustang Ridge Solar");
  });

  it("getUserBookmarks returns empty array when none exist", async () => {
    expect(await getUserBookmarks(env, uid)).toEqual([]);
  });

  it("bookmarks are per-user — another user's bookmarks are invisible", async () => {
    const other = await freshUser("bm-other");
    await toggleBookmark(env, other, SLUG_A);
    expect(await getUserBookmarks(env, uid)).toEqual([]);
  });

  it("double-toggle leaves no bookmark row", async () => {
    await toggleBookmark(env, uid, SLUG_A);
    await toggleBookmark(env, uid, SLUG_A);
    expect(await isBookmarked(env, uid, SLUG_A)).toBe(false);
  });
});

describe("watchlists", () => {
  beforeEach(async () => { uid = await freshUser("wl"); });

  it("createWatchlist returns a new numeric id", async () => {
    const id = await createWatchlist(env, uid, "My Picks");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("getUserWatchlists returns created watchlists", async () => {
    await createWatchlist(env, uid, "Alpha");
    await createWatchlist(env, uid, "Beta");
    const lists = await getUserWatchlists(env, uid);
    expect(lists.length).toBe(2);
    const names = lists.map((l) => l.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
  });

  it("deleteWatchlist removes the watchlist", async () => {
    const id = await createWatchlist(env, uid, "Temp");
    await deleteWatchlist(env, uid, id);
    const lists = await getUserWatchlists(env, uid);
    expect(lists.find((l) => l.id === id)).toBeUndefined();
  });

  it("deleteWatchlist by another user has no effect", async () => {
    const other = await freshUser("wl-other");
    const id = await createWatchlist(env, uid, "Mine");
    await deleteWatchlist(env, other, id); // wrong user — should be a no-op
    const lists = await getUserWatchlists(env, uid);
    expect(lists.find((l) => l.id === id)).toBeDefined();
  });

  it("toggleWatchlistItem adds then removes a project", async () => {
    const id = await createWatchlist(env, uid, "Toggle Test");
    expect(await toggleWatchlistItem(env, uid, id, SLUG_A)).toBe(true);  // added
    expect(await toggleWatchlistItem(env, uid, id, SLUG_A)).toBe(false); // removed
  });

  it("toggleWatchlistItem returns null for a watchlist owned by another user", async () => {
    const other = await freshUser("wl-guard");
    const id = await createWatchlist(env, other, "Other List");
    expect(await toggleWatchlistItem(env, uid, id, SLUG_A)).toBeNull();
  });

  it("getWatchlistItems returns items with project metadata", async () => {
    const id = await createWatchlist(env, uid, "Items Test");
    await toggleWatchlistItem(env, uid, id, SLUG_A);
    await toggleWatchlistItem(env, uid, id, SLUG_B);
    const items = await getWatchlistItems(env, id);
    expect(items.length).toBe(2);
    const slugs = items.map((i) => i.project_slug);
    expect(slugs).toContain(SLUG_A);
    expect(slugs).toContain(SLUG_B);
  });

  it("deleting a watchlist cascades to its items", async () => {
    const id = await createWatchlist(env, uid, "Cascade Test");
    await toggleWatchlistItem(env, uid, id, SLUG_A);
    await deleteWatchlist(env, uid, id);
    // Direct DB check — items table should be empty for this watchlist.
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM watchlist_items WHERE watchlist_id = ?"
    ).bind(id).all();
    expect(results[0].n).toBe(0);
  });
});

describe("notes", () => {
  beforeEach(async () => { uid = await freshUser("note"); });

  it("getNote returns empty string when no note exists", async () => {
    expect(await getNote(env, uid, SLUG_A)).toBe("");
  });

  it("saveNote creates a note, getNote retrieves it", async () => {
    await saveNote(env, uid, SLUG_A, "Interesting project");
    expect(await getNote(env, uid, SLUG_A)).toBe("Interesting project");
  });

  it("saveNote upserts (updates existing note)", async () => {
    await saveNote(env, uid, SLUG_A, "First");
    await saveNote(env, uid, SLUG_A, "Second");
    expect(await getNote(env, uid, SLUG_A)).toBe("Second");
  });

  it("saveNote with empty string deletes the note", async () => {
    await saveNote(env, uid, SLUG_A, "To be deleted");
    await saveNote(env, uid, SLUG_A, "");
    expect(await getNote(env, uid, SLUG_A)).toBe("");
  });

  it("getUserNotes returns all notes with project metadata", async () => {
    await saveNote(env, uid, SLUG_A, "Note A");
    await saveNote(env, uid, SLUG_B, "Note B");
    const notes = await getUserNotes(env, uid);
    expect(notes.length).toBe(2);
    const slugs = notes.map((n) => n.project_slug);
    expect(slugs).toContain(SLUG_A);
    expect(slugs).toContain(SLUG_B);
    expect(notes.find((n) => n.project_slug === SLUG_A).project_name).toBe("Mustang Ridge Solar");
  });

  it("notes are per-user", async () => {
    const other = await freshUser("note-other");
    await saveNote(env, other, SLUG_A, "Not mine");
    expect(await getUserNotes(env, uid)).toEqual([]);
  });

  it("saveNote trims whitespace before storing", async () => {
    await saveNote(env, uid, SLUG_A, "  trimmed  ");
    expect(await getNote(env, uid, SLUG_A)).toBe("trimmed");
  });
});

describe("saved filters", () => {
  beforeEach(async () => { uid = await freshUser("sf"); });

  it("saveFilter returns a new numeric id", async () => {
    const id = await saveFilter(env, uid, "My Filter", JSON.stringify({ sort: "capacity" }));
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("getUserFilters returns saved filters", async () => {
    await saveFilter(env, uid, "Alpha", JSON.stringify({ sort: "name" }));
    await saveFilter(env, uid, "Beta", JSON.stringify({ sort: "status" }));
    const filters = await getUserFilters(env, uid);
    expect(filters.length).toBe(2);
    const names = filters.map((f) => f.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
  });

  it("filter_json round-trips correctly", async () => {
    const json = JSON.stringify({ sort: "capacity", dir: "asc", status: "Planned" });
    const id = await saveFilter(env, uid, "Round trip", json);
    const filters = await getUserFilters(env, uid);
    const f = filters.find((x) => x.id === id);
    expect(JSON.parse(f.filter_json)).toEqual({ sort: "capacity", dir: "asc", status: "Planned" });
  });

  it("deleteFilter removes the filter", async () => {
    const id = await saveFilter(env, uid, "Temp", "{}");
    await deleteFilter(env, uid, id);
    const filters = await getUserFilters(env, uid);
    expect(filters.find((f) => f.id === id)).toBeUndefined();
  });

  it("deleteFilter by another user has no effect", async () => {
    const other = await freshUser("sf-other");
    const id = await saveFilter(env, uid, "Mine", "{}");
    await deleteFilter(env, other, id); // wrong user — no-op
    const filters = await getUserFilters(env, uid);
    expect(filters.find((f) => f.id === id)).toBeDefined();
  });

  it("filters are per-user", async () => {
    const other = await freshUser("sf-other2");
    await saveFilter(env, other, "Not mine", "{}");
    expect(await getUserFilters(env, uid)).toEqual([]);
  });
});

describe("getDashboardData", () => {
  beforeEach(async () => { uid = await freshUser("dash"); });

  it("returns empty collections when nothing is saved", async () => {
    const data = await getDashboardData(env, uid);
    expect(data.bookmarks).toEqual([]);
    expect(data.notes).toEqual([]);
    expect(data.filters).toEqual([]);
    expect(data.watchlists).toEqual([]);
  });

  it("aggregates all four data types in one call", async () => {
    await toggleBookmark(env, uid, SLUG_A);
    await saveNote(env, uid, SLUG_B, "Test note");
    await saveFilter(env, uid, "My filter", "{}");
    const wlId = await createWatchlist(env, uid, "My List");
    await toggleWatchlistItem(env, uid, wlId, SLUG_A);

    const data = await getDashboardData(env, uid);
    expect(data.bookmarks.length).toBe(1);
    expect(data.notes.length).toBe(1);
    expect(data.filters.length).toBe(1);
    expect(data.watchlists.length).toBe(1);
    expect(data.watchlists[0].items.length).toBe(1);
    expect(data.watchlists[0].name).toBe("My List");
  });
});
