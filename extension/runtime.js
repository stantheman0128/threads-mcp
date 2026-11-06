"use strict";
var ThreadsMCP = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name2 in all)
      __defProp(target, name2, { get: all[name2], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/page-runtime.ts
  var page_runtime_exports = {};
  __export(page_runtime_exports, {
    cancelDirectProfiles: () => cancelDirectProfiles,
    cancelMediaTransfers: () => cancelMediaTransfers,
    cancelSocialActions: () => cancelSocialActions,
    directProfile: () => directProfile2,
    interact: () => interact,
    media: () => media,
    openReadPanel: () => openReadPanel,
    readPage: () => readPage,
    runtimeRevision: () => runtimeRevision,
    runtimeVersion: () => runtimeVersion,
    scroll: () => scroll,
    snapshot: () => snapshot,
    socialCommit: () => socialCommit,
    socialInspect: () => socialInspect,
    socialStage: () => socialStage
  });

  // src/urls.ts
  function sameId(a, b) {
    return !!a && !!b && a.split("_")[0] === b.split("_")[0];
  }

  // src/parser.ts
  var number = (...values) => {
    for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    return null;
  };
  var id = (value) => typeof value === "string" && value.length > 0 ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
  var bool = (value) => typeof value === "boolean" ? value : null;
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  function safeMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }
  function normalizePost(value, source = "browser-json", observedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    if (!object(value)) return null;
    const user = value.user || value.owner;
    const code = text(value.code || value.shortcode);
    const username = text(user?.username);
    const postId = id(value.pk) || id(value.id);
    if (!postId || !code || !/^[\w-]+$/.test(code) || !/^[\w.]+$/.test(username)) return null;
    const app = object(value.text_post_app_info) ? value.text_post_app_info : {};
    const fragments = app.text_fragments?.fragments;
    const caption = text(value.caption?.text) || text(value.text) || (Array.isArray(fragments) ? fragments.map((x) => text(x?.plaintext)).join("") : "");
    const media2 = [];
    for (const item of Array.isArray(value.carousel_media) ? value.carousel_media : [value]) {
      const video = safeMediaUrl(item.video_versions?.[0]?.url);
      const image = safeMediaUrl(item.image_versions2?.candidates?.[0]?.url);
      if (video) media2.push({ type: "video", url: video });
      else if (image) media2.push({ type: "image", url: image });
    }
    let createdAt = null;
    const unix = number(value.taken_at, value.timestamp);
    if (unix !== null) {
      const date = new Date(unix < 1e12 ? unix * 1e3 : unix);
      if (Number.isFinite(date.valueOf())) createdAt = date.toISOString();
    }
    const parentId = id(app.reply_to_id) || id(value.reply_to_id) || id(value.replied_to?.id) || id(app.replied_to?.id);
    const rootId = id(app.root_post?.id) || id(value.root_post?.id) || id(app.root_post_id);
    return {
      id: postId,
      code,
      url: `https://www.threads.com/@${username}/post/${code}`,
      author: { username, ...id(user.pk || user.id) ? { id: id(user.pk || user.id) } : {}, ...text(user.full_name) ? { name: text(user.full_name) } : {}, ...typeof user.is_verified === "boolean" ? { verified: user.is_verified } : {} },
      text: caption,
      createdAt,
      likes: value.like_and_view_counts_disabled === true ? null : number(value.like_count),
      replies: number(app.direct_reply_count, value.reply_count),
      reposts: number(app.repost_count, value.repost_count),
      quotes: number(app.quote_count, value.quote_count),
      views: value.like_and_view_counts_disabled === true ? null : number(value.view_count, value.view_counts),
      isReply: bool(app.is_reply ?? value.is_reply),
      parentId,
      rootId,
      likedByViewer: bool(value.has_liked),
      savedByViewer: bool(value.has_viewer_saved),
      media: media2,
      observedAt,
      source
    };
  }
  function normalizeProfile(value) {
    if (!object(value) || typeof value.username !== "string" || !/^[\w.]+$/.test(value.username)) return null;
    if (!["pk", "id", "full_name", "biography", "follower_count", "text_post_app_is_private"].some((k) => k in value)) return null;
    const links2 = Array.isArray(value.bio_links) ? value.bio_links.map((x) => safeMediaUrl(x?.url)).filter((x) => !!x) : [];
    return {
      username: value.username,
      ...id(value.pk || value.id) ? { id: id(value.pk || value.id) } : {},
      ...text(value.full_name) ? { name: text(value.full_name) } : {},
      ...typeof value.is_verified === "boolean" ? { verified: value.is_verified } : {},
      bio: typeof value.biography === "string" ? value.biography : null,
      followers: number(value.follower_count),
      following: number(value.following_count),
      private: bool(value.text_post_app_is_private ?? value.is_private),
      url: `https://www.threads.com/@${value.username}`,
      links: links2
    };
  }
  function mergePost(old, next) {
    const merged = { ...old };
    for (const [key, value] of Object.entries(next)) if (value !== null && value !== void 0 && value !== "" && (!Array.isArray(value) || value.length)) merged[key] = value;
    return merged;
  }
  function dedupePosts(posts) {
    const map = /* @__PURE__ */ new Map();
    for (const post of posts) {
      const key = post.code || post.id;
      map.set(key, map.has(key) ? mergePost(map.get(key), post) : post);
    }
    return [...map.values()];
  }
  function parsePayloads(payloads, options = {}) {
    const candidates = [];
    const profiles = /* @__PURE__ */ new Map();
    const observedAt = options.observedAt || (/* @__PURE__ */ new Date()).toISOString();
    const seen = /* @__PURE__ */ new WeakSet();
    let visited = 0;
    function walk(value, path, replyContextRoot = void 0, bundle = [], depth = 0, scopeRoot) {
      if (!value || typeof value !== "object" || depth > 65 || visited++ > 15e4 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`, replyContextRoot, bundle, depth + 1, scopeRoot));
        return;
      }
      const obj = value;
      const post = normalizePost(obj, options.source, observedAt);
      const mediaFragmentId = object(obj.text_post_app_info) ? id(obj.id) || id(obj.pk) : null;
      const containerRoot = post?.code || obj.post?.code || obj.thread_items?.[0]?.post?.code || obj.containing_thread?.thread_items?.[0]?.post?.code || mediaFragmentId;
      const nextScope = typeof containerRoot === "string" ? containerRoot : scopeRoot;
      const profile = normalizeProfile(obj);
      if (profile) {
        const prev = profiles.get(profile.username);
        profiles.set(profile.username, prev ? Object.fromEntries(Object.keys({ ...prev, ...profile }).map((k) => [k, profile[k] ?? prev[k]])) : profile);
      }
      if (post) candidates.push({ post, path, replyContextRoot, bundle });
      for (const [key, child] of Object.entries(obj)) {
        if (/^(relatedPosts|related_posts|suggested_posts|suggestedUsers|suggested_users|share_info|quoted_post|quoted_attachment|quoted_attachment_post|reposted_post)$/.test(key)) continue;
        const nextReplyRoot = /^(direct_replies|reply_threads|replies|reply_connection|thread_replies|replies_connection)$/i.test(key) ? replyContextRoot ?? nextScope : replyContextRoot;
        if (key === "thread_items" && Array.isArray(child)) {
          const codes = child.map((x) => x?.post?.code).filter((x) => typeof x === "string");
          walk(child, `${path}.${key}`, nextReplyRoot, codes, depth + 1, nextScope);
        } else walk(child, `${path}.${key}`, nextReplyRoot, bundle, depth + 1, nextScope);
      }
    }
    payloads.forEach((payload, i) => walk(payload, `payload[${i}]`));
    const posts = dedupePosts(candidates.map((x) => x.post));
    const root = options.rootCode ? posts.find((p) => p.code === options.rootCode) : void 0;
    const replies = root ? dedupePosts(candidates.filter((c) => c.post.code !== root.code && (sameId(c.post.rootId, root.id) || sameId(c.post.parentId, root.id) || (!c.post.rootId || sameId(c.post.rootId, root.id)) && (c.replyContextRoot === root.code || sameId(c.replyContextRoot, root.id) || c.bundle.includes(root.code) && c.post.isReply === true))).map((c) => ({ ...c.post, rootId: c.post.rootId || root.id }))) : [];
    return { posts, profiles: [...profiles.values()], replies, warnings: visited > 15e4 ? ["Payload traversal limit reached; result is partial."] : [] };
  }
  function parseWire(text2) {
    const clean = text2.replace(/^for\s*\(;;\);\s*/, "").trim();
    try {
      return [JSON.parse(clean)];
    } catch {
      return clean.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    }
  }
  function parseCount(value) {
    if (!value) return null;
    const match = value.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB萬万億亿])?/i);
    if (!match) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9, "\u842C": 1e4, "\u4E07": 1e4, "\u5104": 1e8, "\u4EBF": 1e8 };
    return Math.round(Number(match[1]) * (scale[(match[2] || "").toLowerCase()] || 1));
  }

  // src/direct-profile-runtime.ts
  var active = /* @__PURE__ */ new Set();
  var queryName = "BarcelonaProfileThreadsTabRefetchableDirectQuery";
  var totalBudgetMs = 45e3;
  var DirectFailure = class extends Error {
    constructor(reason) {
      super(`DIRECT_PROFILE_${reason.toUpperCase()}`);
      this.reason = reason;
    }
    reason;
  };
  function fail(reason) {
    throw new DirectFailure(reason);
  }
  function numericId(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const text2 = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return /^\d+$/.test(text2) ? text2 : null;
  }
  function cancelDirectProfiles() {
    for (const controller of active) controller.abort(new DirectFailure("cancelled"));
  }
  async function directProfile(args, context3) {
    const { username, maxPages } = args, pageSize = args.pageSize ?? 10;
    if (!/^[\w.]{1,64}$/.test(username) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new Error("DIRECT_PROFILE_INVALID_INPUT");
    const route = location.href, viewer2 = context3.viewer(), started = Date.now();
    const url = new URL(route);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !["www.threads.com", "threads.com"].includes(url.hostname) || url.pathname !== `/@${username}` && url.pathname !== `/@${username}/` || !viewer2) fail("binding_unavailable");
    const queryUrl = new URL("/graphql/query", url.origin).href;
    const controller = new AbortController();
    active.add(controller);
    const check2 = () => {
      if (controller.signal.aborted) throw controller.signal.reason instanceof DirectFailure ? controller.signal.reason : new DirectFailure("cancelled");
      if (Date.now() - started >= totalBudgetMs) fail("time_limit");
      if (location.href !== route || context3.viewer() !== viewer2) fail("context_changed");
      try {
        context3.guard();
      } catch {
        fail("context_changed");
      }
    };
    const onManual = (event) => {
      if (event.isTrusted) controller.abort(new DirectFailure("context_changed"));
    };
    const onNavigation = () => controller.abort(new DirectFailure("context_changed"));
    for (const type of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(type, onManual, true);
    for (const type of ["pagehide", "beforeunload"]) globalThis.addEventListener(type, onNavigation);
    const watch = setInterval(() => {
      try {
        check2();
      } catch (error) {
        controller.abort(error);
      }
    }, 100);
    const deadline = setTimeout(() => controller.abort(new DirectFailure("time_limit")), totalBudgetMs);
    const observedAt = (/* @__PURE__ */ new Date()).toISOString();
    const result = {
      profile: null,
      items: [],
      contextualPosts: [],
      sourceUrl: route,
      observedAt,
      completeness: "partial",
      warnings: [],
      pagination: { provider: "direct", pagesFetched: 0, requests: 0, uniquePosts: 0, hasNext: null, stopReason: "page_limit", pages: [] }
    };
    const readText = async (requestUrl, options, cap, timeout) => {
      check2();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(timeout, totalBudgetMs - (Date.now() - started)))]);
      let response;
      try {
        response = await fetch(requestUrl, { ...options, redirect: "error", signal });
      } catch {
        check2();
        fail("request_failed");
      }
      check2();
      if (!response.ok) {
        await response.body?.cancel();
        fail("http_rejected");
      }
      if (!response.body) fail("schema_unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0, text2 = "";
      try {
        while (true) {
          const part = await reader.read();
          check2();
          if (part.done) break;
          size += part.value.length;
          if (size > cap) fail("response_limit");
          text2 += decoder.decode(part.value, { stream: true });
        }
        return text2 + decoder.decode();
      } catch (error) {
        await reader.cancel().catch(() => {
        });
        check2();
        if (error instanceof DirectFailure) throw error;
        fail("request_failed");
      } finally {
        reader.releaseLock();
      }
    };
    try {
      check2();
      const profiles = [], variables = [], connections = [];
      let lsd, dtsg, csrf, bloks;
      let nodes = 0, bootstrapBytes = 0;
      const walk = (value, depth = 0) => {
        if (!value || typeof value !== "object") return;
        if (++nodes > 15e4 || depth > 40) fail("response_limit");
        if (value.username === username && numericId(value.pk ?? value.id)) profiles.push(value);
        if (value.variables?.userID && typeof value.variables.first === "number") variables.push(value.variables);
        if (value.mediaData?.page_info && Array.isArray(value.mediaData.edges)) connections.push(value.mediaData);
        if (Array.isArray(value)) {
          if (value[0] === "LSD" && typeof value[2]?.token === "string") lsd = value[2].token;
          if (value[0] === "DTSGInitialData" && typeof value[2]?.token === "string") dtsg = value[2].token;
          if (value[0] === "InstagramSecurityConfig" && typeof value[2]?.csrf_token === "string") csrf = value[2].csrf_token;
          if (value[0] === "WebBloksVersioningID" && typeof value[2]?.versioningID === "string") bloks = value[2].versioningID;
        }
        for (const child of Object.values(value)) walk(child, depth + 1);
      };
      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        const text2 = script.textContent ?? "";
        bootstrapBytes += text2.length;
        if (bootstrapBytes > 12e6) fail("response_limit");
        for (const payload of parseWire(text2)) walk(payload);
      }
      const ids = new Set(profiles.map((profile) => numericId(profile.pk ?? profile.id)));
      const privacy = profiles.map((profile) => profile.text_post_app_is_private).filter((value) => typeof value === "boolean");
      if (ids.size !== 1 || !privacy.length || privacy.some(Boolean)) fail("binding_unavailable");
      const targetId = [...ids][0];
      const boundVariables = variables.filter((value) => numericId(value.userID) === targetId);
      const boundConnections = connections.filter((value) => value.edges.length > 0 && value.edges.every((edge) => edge.node?.thread_items?.[0]?.post?.user?.username === username));
      if (boundVariables.length !== 1 || boundConnections.length !== 1) fail("binding_unavailable");
      result.profile = normalizeProfile(profiles.find((profile) => profile.text_post_app_is_private === false));
      const knownIds = /* @__PURE__ */ new Set(), knownCodes = /* @__PURE__ */ new Set(), cursors = /* @__PURE__ */ new Set();
      let cursor = null;
      const acceptPage = (connection, initial) => {
        if (!Array.isArray(connection.edges) || connection.edges.length > (initial ? 100 : pageSize) || !connection.page_info || typeof connection.page_info.has_next_page !== "boolean") fail("schema_unavailable");
        const rawPosts = connection.edges.map((edge) => edge.node?.thread_items?.[0]?.post);
        for (const post of rawPosts) {
          if (!post || !numericId(post.pk ?? post.id) || post.user?.username !== username || numericId(post.user.pk ?? post.user.id) !== targetId || typeof post.code !== "string" || !/^[\w-]+$/.test(post.code)) fail("binding_unavailable");
        }
        const allowedIds = new Set(rawPosts.map((post) => numericId(post.pk ?? post.id)));
        const parsed = parsePayloads(rawPosts, { source: "profile-direct", observedAt });
        const normalized = parsed.posts.filter((post) => allowedIds.has(post.id) && post.author.username === username);
        if (new Set(normalized.map((post) => post.id)).size !== allowedIds.size || parsed.warnings.length) fail("schema_unavailable");
        let added = 0;
        for (const post of normalized) {
          if (knownIds.has(post.id) || knownCodes.has(post.code)) continue;
          knownIds.add(post.id);
          knownCodes.add(post.code);
          result.items.push(post);
          added++;
        }
        const next = typeof connection.page_info.end_cursor === "string" && connection.page_info.end_cursor.length > 0 ? connection.page_info.end_cursor : null;
        const advanced = initial ? null : next !== null && next !== cursor;
        result.pagination.pagesFetched++;
        result.pagination.pages.push({ page: result.pagination.pagesFetched, received: rawPosts.length, added, cursorAdvanced: advanced });
        result.pagination.uniquePosts = result.items.length;
        result.pagination.hasNext = connection.page_info.has_next_page;
        if (!result.pagination.hasNext) result.pagination.stopReason = "end_of_connection";
        else if (!next) result.pagination.stopReason = "cursor_missing";
        else if (cursors.has(next)) result.pagination.stopReason = "cursor_loop";
        else if (!initial && !added) result.pagination.stopReason = "no_progress";
        else result.pagination.stopReason = "page_limit";
        if (next) cursors.add(next);
        cursor = next;
      };
      acceptPage(boundConnections[0], true);
      if (maxPages === 1 || result.pagination.stopReason !== "page_limit") return result;
      if (!lsd || !dtsg || !csrf) fail("binding_unavailable");
      let docId, artifact, staticBytes = 0;
      const scripts = [...document.querySelectorAll("script[src]")].map((script) => script.src).filter((src) => {
        try {
          const u = new URL(src);
          return u.protocol === "https:" && !u.username && !u.password && /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname);
        } catch {
          return false;
        }
      });
      for (const src of [...new Set(scripts)].slice(0, 50)) {
        check2();
        let text2;
        try {
          text2 = await readText(src, { credentials: "omit" }, 5e6, 2e3);
        } catch (error) {
          if (error instanceof DirectFailure && ["http_rejected", "request_failed"].includes(error.reason)) continue;
          throw error;
        }
        staticBytes += text2.length;
        if (staticBytes > 15e6) fail("response_limit");
        const match = /__d\("BarcelonaProfileThreadsTabRefetchableDirectQuery_threadsRelayOperation",\[\],[\s\S]{0,130}?\.exports="(\d{10,30})"/.exec(text2);
        if (match) docId = match[1];
        const start = text2.indexOf(`__d("${queryName}.threads.graphql"`);
        if (start >= 0) {
          const end = text2.indexOf("__d(", start + 4);
          artifact = text2.slice(start, end < 0 ? void 0 : end);
        }
        if (docId && artifact) break;
      }
      if (!docId || !artifact?.includes('operationKind:"query"') || !artifact.includes(`name:"${queryName}"`)) fail("query_unavailable");
      const flags = [...new Set(artifact.match(/__relay_internal__pv__[A-Za-z0-9_]+/g) ?? [])];
      const currentVariables = boundVariables[0];
      if (flags.some((key) => typeof currentVariables[key] !== "boolean")) fail("binding_unavailable");
      while (result.pagination.pagesFetched < maxPages && result.pagination.stopReason === "page_limit") {
        check2();
        const nextVariables = {
          ...Object.fromEntries(flags.map((key) => [key, currentVariables[key]])),
          userID: targetId,
          first: pageSize,
          after: cursor,
          before: null,
          last: null,
          allow_page_info_for_lox_user: currentVariables.allow_page_info_for_lox_user
        };
        const body = new URLSearchParams({
          __a: "1",
          fb_dtsg: dtsg,
          lsd,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: queryName,
          doc_id: docId,
          variables: JSON.stringify(nextVariables),
          server_timestamps: "true"
        });
        result.pagination.requests++;
        const text2 = await readText(queryUrl, { method: "POST", credentials: "same-origin", headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-FB-LSD": lsd,
          "X-CSRFToken": csrf,
          "X-IG-App-ID": "238260118697367",
          ...bloks ? { "X-BLOKS-VERSION-ID": bloks } : {}
        }, body }, 3e6, 12e3);
        const payloads = parseWire(text2);
        if (payloads.some((payload) => Array.isArray(payload.errors) && payload.errors.length)) fail("graphql_error");
        const pages = payloads.filter((payload) => payload.data?.mediaData).map((payload) => payload.data.mediaData);
        if (pages.length !== 1) fail("schema_unavailable");
        check2();
        acceptPage(pages[0], false);
      }
      return result;
    } catch (error) {
      const reason = error instanceof DirectFailure ? error.reason : "request_failed";
      if (!result.pagination.pagesFetched || reason === "context_changed" || reason === "cancelled") throw new DirectFailure(reason);
      result.pagination.stopReason = reason;
      result.warnings.push(`Direct profile pagination stopped: ${reason}. Results cover only accepted pages.`);
      return result;
    } finally {
      clearInterval(watch);
      clearTimeout(deadline);
      active.delete(controller);
      controller.abort();
      for (const type of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(type, onManual, true);
      for (const type of ["pagehide", "beforeunload"]) globalThis.removeEventListener(type, onNavigation);
    }
  }

  // src/media-runtime.ts
  var transfer;
  var generation = 0;
  var opening = false;
  var manualEpoch = 0;
  var removeManualWatch;
  var approved;
  var maxTotal = 64 * 1024 * 1024;
  function fail2(code, message) {
    throw new Error(`${code}: ${message}`);
  }
  function visible(el) {
    return el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" && !el.closest('[aria-hidden="true"]');
  }
  function account() {
    const accounts = [...document.querySelectorAll('a[href^="/@"]')].filter(visible).filter((el) => /^(Profile|個人檔案)$/i.test(el.getAttribute("aria-label") || el.querySelector("svg")?.getAttribute("aria-label") || "")).map((el) => el.getAttribute("href")?.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter(Boolean);
    if (new Set(accounts).size !== 1) fail2("ACCOUNT_UNVERIFIED", "A unique visible account profile control is required.");
    return accounts[0];
  }
  function guard() {
    if (location.protocol !== "https:" || !["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(location.hostname))
      fail2("WRONG_PAGE", "Only a selected HTTPS Threads page is supported.");
  }
  function attachmentScope(dialog, editor) {
    const body = editor.closest('[data-barcelona-composer-body="true"]');
    return body && dialog.contains(body) ? body : dialog;
  }
  function fingerprint(dialog, editor, input) {
    return JSON.stringify([
      editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent,
      editor.getAttribute("contenteditable"),
      editor.getAttribute("aria-label"),
      input.accept,
      input.multiple,
      input.disabled,
      [...input.files || []].map((file) => [file.name, file.size, file.type, file.lastModified]),
      [...dialog.querySelectorAll('img[src^="blob:"],video,button[aria-label],[role="button"][aria-label]')].map((el) => [el.tagName, el.getAttribute("src"), el.getAttribute("aria-label")])
    ]);
  }
  function composer() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    if (dialogs.length !== 1) fail2("MEDIA_COMPOSER_REQUIRED", "Open exactly one empty composer dialog before staging files.");
    const dialog = dialogs[0];
    const editors2 = [...dialog.querySelectorAll('[contenteditable="true"],textarea')].filter(visible);
    const inputs = [...dialog.querySelectorAll('input[type="file"]')];
    if (editors2.length !== 1 || inputs.length !== 1) fail2("MEDIA_COMPOSER_AMBIGUOUS", "A unique composer and file input are required.");
    const editor = editors2[0];
    const input = inputs[0];
    const text2 = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent || "";
    const attachments = attachmentScope(dialog, editor);
    const previews = [...attachments.querySelectorAll("img,video")].some((el) => el.tagName === "VIDEO" || !/(profile picture|profile photo|大頭貼|頭像)/i.test(el.getAttribute("alt") || ""));
    const removeControls = [...attachments.querySelectorAll("[aria-label]")].some((el) => /^(Remove|Delete|移除|刪除)(?:$|\s*(media|image|photo|video|attachment|圖片|相片|影片|附件))/i.test(el.getAttribute("aria-label") || ""));
    if (text2.trim() || input.files?.length || previews || removeControls) fail2("MEDIA_DRAFT_EXISTS", "Existing draft text or attachments must be preserved; use an empty composer.");
    if (input.disabled || input.getAttribute("aria-disabled") === "true" || editor.getAttribute("aria-disabled") === "true") fail2("MEDIA_INPUT_DISABLED", "The composer is disabled.");
    return { dialog, editor, input };
  }
  function check(current2) {
    guard();
    if (current2.generation !== generation) fail2("MEDIA_CANCELLED", "The transfer was cancelled; no files were dispatched.");
    if (Date.now() > current2.expires) {
      clear();
      fail2("MEDIA_EXPIRED", "The transfer expired.");
    }
    if (manualEpoch !== current2.manualEpoch || location.href !== current2.url || account() !== current2.account || !current2.dialog.isConnected || !current2.input.isConnected || !current2.editor.isConnected || !visible(current2.dialog) || !visible(current2.editor) || fingerprint(current2.dialog, current2.editor, current2.input) !== current2.fingerprint)
      fail2("MEDIA_COMPOSER_CHANGED", "The account, page, composer or file input changed; no files were dispatched.");
    const fresh = composer();
    if (fresh.dialog !== current2.dialog || fresh.editor !== current2.editor || fresh.input !== current2.input)
      fail2("MEDIA_COMPOSER_CHANGED", "The composer changed; no files were dispatched.");
    if (current2.binding) assertMediaComposerBinding(current2.binding);
  }
  function watchManualTakeover() {
    if (removeManualWatch) return;
    const events = ["pointerdown", "mousedown", "touchstart", "keydown", "beforeinput", "input", "paste", "cut", "drop", "wheel"];
    const listener = (event) => {
      if (event.isTrusted) manualEpoch++;
    };
    for (const type of events) document.addEventListener(type, listener, true);
    removeManualWatch = () => {
      for (const type of events) document.removeEventListener(type, listener, true);
    };
  }
  function clear() {
    if (transfer) clearTimeout(transfer.timer);
    transfer = void 0;
  }
  function cancelMediaTransfers() {
    generation++;
    clear();
    if (approved) clearTimeout(approved.timer);
    approved = void 0;
    removeManualWatch?.();
    removeManualWatch = void 0;
  }
  function accepts(input, file) {
    const accept = input.accept.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    return !accept.length || accept.some((value) => value === file.mime || value === `${file.mime.split("/")[0]}/*` || value.startsWith(".") && file.name.toLowerCase().endsWith(value));
  }
  function assertApprovedMedia(mediaToken, scope) {
    guard();
    const state = approved;
    if (!state || state.manualEpoch !== manualEpoch || state.token !== mediaToken || Date.now() > state.expires || location.href !== state.url || account() !== state.account || scope !== state.dialog || !scope.isConnected || !visible(scope) || !state.input.isConnected || !scope.contains(state.input))
      fail2("MEDIA_APPROVAL_STALE", "The staged media approval is missing, expired or belongs to another composer.");
    const files = [...state.input.files || []];
    if (files.length !== state.files.length || files.some((file, index) => file !== state.files[index]))
      fail2("MEDIA_APPROVAL_STALE", "The composer attachments changed.");
    const attachments = attachmentScope(scope, state.editor);
    if (attachments !== state.attachmentScope) fail2("MEDIA_APPROVAL_STALE", "The editable attachment region changed.");
    const previews = [...attachments.querySelectorAll('img[src^="blob:"],video')].filter(visible).map((node) => ({ node, source: node.getAttribute("src") }));
    if (previews.length !== state.files.length) fail2("MEDIA_PREVIEW_UNVERIFIED", "Every staged file needs one visible attachment preview; missing or additional previews cannot be approved.");
    if (state.previews && (previews.length !== state.previews.length || previews.some((preview, index) => preview.node !== state.previews[index].node || preview.source !== state.previews[index].source)))
      fail2("MEDIA_APPROVAL_STALE", "The attachment preview changed after preparation.");
    state.previews ??= previews;
    if (state.binding) assertMediaComposerBinding(state.binding);
    return state.binding;
  }
  async function media(command) {
    guard();
    if (transfer && Date.now() > transfer.expires) clear();
    if (command.operation === "begin") {
      if (transfer || opening) fail2("MEDIA_BUSY", "Another transfer is already pending.");
      if (typeof command.expectedAccount !== "string" || !/^[\w.]{1,30}$/.test(command.expectedAccount)) fail2("INVALID_MEDIA", "An expected account is required.");
      const verifiedAccount = account();
      if (command.expectedAccount.toLowerCase() !== verifiedAccount) fail2("ACCOUNT_MISMATCH", "The selected account does not match.");
      if (!Array.isArray(command.files) || command.files.length < 1 || command.files.length > 20) fail2("INVALID_MEDIA", "Provide between 1 and 20 files.");
      let total = 0;
      const manifests = command.files.map((file) => {
        if (!file || typeof file.name !== "string" || !file.name || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name) || !["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/quicktime", "video/webm"].includes(file.mime) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > (file.mime.startsWith("image/") ? 8 * 1024 * 1024 : maxTotal) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail2("INVALID_MEDIA", "Invalid file manifest.");
        total += file.size;
        if (total > maxTotal) fail2("MEDIA_SIZE_LIMIT", "The total byte limit is 64 MiB.");
        return { name: file.name, mime: file.mime, size: file.size, sha256: file.sha256 };
      });
      const expectedGeneration = generation, expectedManualEpoch = manualEpoch;
      watchManualTakeover();
      let binding;
      if (command.compose !== void 0) {
        opening = true;
        try {
          binding = await openMediaComposer(command.compose, verifiedAccount);
        } finally {
          opening = false;
        }
      }
      if (generation !== expectedGeneration) fail2("MEDIA_CANCELLED", "The transfer was cancelled while opening its composer.");
      if (manualEpoch !== expectedManualEpoch) fail2("MEDIA_COMPOSER_CHANGED", "Manual interaction took ownership of the composer.");
      if (account() !== verifiedAccount) fail2("ACCOUNT_MISMATCH", "The selected account changed.");
      const { dialog, editor, input } = composer();
      if (binding && (binding.scope !== dialog || binding.editor !== editor)) fail2("MEDIA_COMPOSER_CHANGED", "The opened composer was replaced.");
      if (manifests.length > 1 && !input.multiple) fail2("MEDIA_MULTIPLE_UNSUPPORTED", "The selected file input does not accept multiple files.");
      if (manifests.some((file) => !accepts(input, file))) fail2("MEDIA_INPUT_TYPE_UNSUPPORTED", "The file input does not accept this media type.");
      const id2 = crypto.randomUUID();
      transfer = {
        id: id2,
        generation,
        url: location.href,
        account: verifiedAccount,
        expires: Date.now() + 3e5,
        timer: setTimeout(clear, 3e5),
        dialog,
        editor,
        input,
        fingerprint: fingerprint(dialog, editor, input),
        manualEpoch,
        binding,
        files: manifests.map((manifest) => ({ manifest, bytes: new Uint8Array(manifest.size), received: 0 }))
      };
      return { uploadId: id2, expiresInMs: 3e5, maxChunkBytes: 32 * 1024 };
    }
    if (!transfer || transfer.id !== command.uploadId) fail2("MEDIA_TRANSFER_MISSING", "No matching pending transfer.");
    if (command.operation === "abort") {
      clear();
      return { aborted: true, composerChanged: false };
    }
    const current2 = transfer;
    check(current2);
    if (command.operation === "chunk") {
      if (!Number.isInteger(command.fileIndex) || !Number.isInteger(command.offset) || typeof command.data !== "string" || command.data.length < 4 || command.data.length > 43692 || !/^[A-Za-z0-9+/]+={0,2}$/.test(command.data)) fail2("INVALID_MEDIA_CHUNK", "Invalid bounded base64 chunk.");
      const file = current2.files[command.fileIndex];
      if (!file || command.offset !== file.received) fail2("INVALID_MEDIA_CHUNK", "Chunks must arrive once in order.");
      const decoded = atob(command.data);
      if (btoa(decoded) !== command.data || decoded.length > 32768 || decoded.length > file.bytes.length - file.received) fail2("INVALID_MEDIA_CHUNK", "Chunk exceeds the remaining file size.");
      file.bytes.set(Uint8Array.from(decoded, (value) => value.charCodeAt(0)), file.received);
      file.received += decoded.length;
      return { received: file.received, fileIndex: command.fileIndex };
    }
    if (command.operation !== "finish") fail2("INVALID_MEDIA_COMMAND", "Unknown media operation.");
    clear();
    for (const file of current2.files) {
      if (file.received !== file.manifest.size) fail2("MEDIA_INCOMPLETE", "All file bytes must be transferred before staging.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", file.bytes));
      if ([...digest].map((value) => value.toString(16).padStart(2, "0")).join("") !== file.manifest.sha256) fail2("MEDIA_HASH_MISMATCH", "The transferred file does not match its manifest.");
    }
    check(current2);
    const data = new DataTransfer();
    for (const file of current2.files) data.items.add(new File([file.bytes], file.manifest.name, { type: file.manifest.mime }));
    current2.input.files = data.files;
    current2.input.dispatchEvent(new Event("input", { bubbles: true }));
    current2.input.dispatchEvent(new Event("change", { bubbles: true }));
    const mediaToken = crypto.randomUUID();
    if (approved) clearTimeout(approved.timer);
    approved = {
      token: mediaToken,
      expires: Date.now() + 6e5,
      timer: setTimeout(() => {
        approved = void 0;
      }, 6e5),
      url: current2.url,
      account: current2.account,
      dialog: current2.dialog,
      editor: current2.editor,
      attachmentScope: attachmentScope(current2.dialog, current2.editor),
      input: current2.input,
      files: [...data.files],
      manualEpoch: current2.manualEpoch,
      binding: current2.binding
    };
    const result = {
      status: "staged",
      mediaToken,
      fileCount: current2.files.length,
      files: current2.files.map((file) => file.manifest.name),
      published: false,
      previewReady: null,
      warning: "Files were assigned and input events dispatched. Inspect the actual preview and wait for processing before preparing publication."
    };
    return result;
  }

  // src/social-runtime.ts
  var socialKinds = ["like", "unlike", "save", "unsave", "repost", "unrepost", "follow", "unfollow", "publish", "reply", "quote", "delete"];
  var staged;
  var generation2 = 0;
  var removeTakeoverWatch;
  var expiryTimer;
  function cancelSocialActions() {
    generation2++;
    staged = void 0;
    removeTakeoverWatch?.();
    removeTakeoverWatch = void 0;
    if (expiryTimer !== void 0) window.clearTimeout(expiryTimer);
    expiryTimer = void 0;
  }
  function watchManualTakeover2(expectedGeneration) {
    const events = ["pointerdown", "mousedown", "touchstart", "keydown", "beforeinput", "input", "paste", "cut", "drop", "wheel"];
    const onInteraction = (event) => {
      if (event.isTrusted && generation2 === expectedGeneration) cancelSocialActions();
    };
    for (const type of events) document.addEventListener(type, onInteraction, true);
    removeTakeoverWatch = () => {
      for (const type of events) document.removeEventListener(type, onInteraction, true);
    };
  }
  function assertGeneration(expected) {
    if (generation2 !== expected) fail3("ACTION_CANCELLED", "Browser preparation was cancelled or superseded; no further input was dispatched.");
  }
  function fail3(code, message) {
    throw new Error(`${code}: ${message}`);
  }
  var isVisible = (el) => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" && !el.closest('[aria-hidden="true"], [inert]');
  var normalizedName = (value) => (value || "").trim().replace(/\s+/g, " ");
  function name(el) {
    const explicit = normalizedName(el.getAttribute("aria-label"));
    if (explicit) return explicit;
    const iconNames = [];
    for (const icon of el.querySelectorAll("svg")) {
      if (icon.closest('button,[role="button"],[role="menuitem"],a') !== el || icon.closest('[aria-hidden="true"],[inert]') || !icon.getClientRects().length || getComputedStyle(icon).display === "none" || getComputedStyle(icon).visibility === "hidden") continue;
      const aria = normalizedName(icon.getAttribute("aria-label"));
      if (aria) {
        iconNames.push(aria);
        continue;
      }
      const labels = [normalizedName(icon.getAttribute("title")), ...[...icon.children].filter((child) => child.localName === "title").map((child) => normalizedName(child.textContent))].filter(Boolean);
      if (new Set(labels).size > 1) return "";
      if (labels[0]) iconNames.push(labels[0]);
    }
    if (iconNames.length > 1) return "";
    return iconNames[0] || normalizedName(el.innerText);
  }
  var controls = (scope) => [...scope.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(isVisible);
  var fingerprint2 = (el) => JSON.stringify([el.tagName, el.getAttribute("role"), name(el), el.getAttribute("aria-pressed"), el.getAttribute("aria-expanded"), el.getAttribute("aria-disabled"), el.innerText]);
  var overlays = () => [...document.querySelectorAll('[role="dialog"],[role="menu"]')].filter(isVisible);
  function only(values, message, code = "AMBIGUOUS_UI") {
    if (values.length !== 1) fail3(code, message);
    return values[0];
  }
  function account2() {
    const names = [...document.querySelectorAll("a[href]")].filter(isVisible).filter((el) => /^(Profile|個人檔案)$/i.test(name(el))).map((el) => el.pathname.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter((x) => !!x);
    return only([...new Set(names)], "A unique signed-in account must be visible in the profile navigation.", "AMBIGUOUS_UI_ACCOUNT_NAV");
  }
  function canonical(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return fail3("INVALID_INPUT", "A full Threads HTTPS URL is required.");
    }
    if (url.protocol !== "https:" || !["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(url.hostname) || url.username || url.password || url.port)
      fail3("INVALID_INPUT", "Only canonical Threads HTTPS URLs are allowed.");
    url.hostname = "www.threads.com";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.href;
  }
  function requestChecked(request, inspectOnly = false) {
    if (!socialKinds.includes(request.kind)) fail3("INVALID_INPUT", "Unknown social action.");
    const targetUrl = canonical(request.targetUrl);
    const path = new URL(targetUrl).pathname;
    if (["follow", "unfollow"].includes(request.kind) ? !/^\/@[\w.]+$/.test(path) : request.kind === "publish" ? path !== "/" : !/^\/@[\w.]+\/post\/[\w-]+$/.test(path))
      fail3("INVALID_INPUT", "Use the exact profile/post permalink; publishing requires the Threads home URL.");
    if (["publish", "reply", "quote"].includes(request.kind)) {
      if (!(inspectOnly && request.text === void 0) && (typeof request.text !== "string" || !request.text.trim() || Array.from(request.text).length > 500))
        fail3("INVALID_INPUT", "Browser publication requires non-empty text of at most 500 characters.");
    } else if (request.text !== void 0 || request.mediaToken !== void 0) fail3("INVALID_INPUT", "Text and approved media are only accepted for publish, reply and quote.");
    if (request.mediaToken !== void 0 && (typeof request.mediaToken !== "string" || !/^[\w-]{1,100}$/.test(request.mediaToken))) fail3("INVALID_INPUT", "An approved media token is required.");
    return { kind: request.kind, targetUrl, ...request.text !== void 0 ? { text: request.text } : {}, ...request.mediaToken ? { mediaToken: request.mediaToken } : {} };
  }
  function context(request) {
    const url = canonical(location.href);
    if (url !== request.targetUrl) fail3("TARGET_CHANGED_ROUTE", "Navigate to the exact target URL before staging this action.");
    return { url, account: account2() };
  }
  function links(scope = document) {
    return [...scope.querySelectorAll('a[href*="/post/"]')].filter(isVisible).flatMap((el) => {
      try {
        const url = new URL(el.href);
        if (!/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)) return [];
        return [{ el, url: canonical(url.href) }];
      } catch {
        return [];
      }
    });
  }
  function postCard(target) {
    const candidates = /* @__PURE__ */ new Set();
    for (const link of links().filter((link2) => link2.url === target)) {
      let node = link.el;
      for (let depth = 0; node && depth < 16; depth++, node = node.parentElement) {
        const reactions = controls(node).filter((el) => /^(Like|Unlike|讚|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i.test(name(el)));
        if (reactions.length === 1 && !links(node).some((link2) => link2.url !== target)) {
          candidates.add(node);
          break;
        }
        if (reactions.length > 1) break;
      }
    }
    const isolated = [...candidates].filter((candidate) => ![...candidates].some((other) => other !== candidate && candidate.contains(other)));
    return only(isolated, "An isolated post card matching the exact permalink was not uniquely identified.", "AMBIGUOUS_UI_POST_SCOPE");
  }
  var matchers = {
    like: /^(Like|讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i,
    unlike: /^(Unlike|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i,
    save: /^(Save|儲存|收藏)$/i,
    unsave: /^(Unsave|Remove from saved|取消儲存|取消收藏)$/i,
    repost: /^(Repost|轉發)$/i,
    unrepost: /^(Remove repost|Undo repost|移除轉發|取消轉發)$/i,
    follow: /^(Follow|追蹤)$/i,
    unfollow: /^(Unfollow|Following|取消追蹤|追蹤中)$/i,
    delete: /^(Delete|Delete post|刪除|刪除貼文)$/i
  };
  var inverse = { like: "unlike", unlike: "like", save: "unsave", unsave: "save", repost: "unrepost", unrepost: "repost", follow: "unfollow", unfollow: "follow" };
  function profileScope(request) {
    const wanted = new URL(request.targetUrl).pathname.slice(2).toLowerCase();
    const scopes = /* @__PURE__ */ new Set();
    for (const heading of [...document.querySelectorAll("h1")].filter(isVisible)) {
      if (heading.closest('aside,nav,[role="complementary"],[role="navigation"],[data-pagelet*="timeline"],article')) continue;
      let scope = heading.parentElement;
      for (let depth = 0; scope && depth < 14; depth++, scope = scope.parentElement) {
        const tab = profileTab(request, scope);
        if (!tab || !precedes(heading, tab)) continue;
        const exactHandle = [...scope.querySelectorAll("span,div,p")].filter(isVisible).some((el) => !el.children.length && normalizedName(el.innerText).replace(/^@/, "").toLowerCase() === wanted && precedes(el, tab));
        const hasSection = [...scope.querySelectorAll("a[href]")].filter(isVisible).some((el) => {
          try {
            return [request.targetUrl + "/replies", request.targetUrl + "/media", request.targetUrl + "/reposts"].includes(canonical(el.href));
          } catch {
            return false;
          }
        });
        if (exactHandle && hasSection) {
          scopes.add(scope);
          break;
        }
      }
    }
    if (!scopes.size) for (const header of [...document.querySelectorAll('header,[role="banner"]')].filter(isVisible)) {
      if (header.closest('aside,nav,[role="complementary"],[role="navigation"],article,[data-pagelet*="timeline"]')) continue;
      if ([...header.querySelectorAll("a[href]")].filter(isVisible).some((a) => {
        try {
          return canonical(a.href) === request.targetUrl;
        } catch {
          return false;
        }
      })) scopes.add(header);
    }
    const isolated = [...scopes].filter((candidate) => ![...scopes].some((other) => other !== candidate && candidate.contains(other)));
    return only(isolated, "A unique profile heading, exact username and matching profile tabs are required; suggested profiles and post rows are excluded.", "AMBIGUOUS_UI_PROFILE_SCOPE");
  }
  function precedes(first, second) {
    return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function profileTab(request, scope) {
    const tabs = [...scope.querySelectorAll("a[href]")].filter(isVisible).filter((el) => {
      try {
        return canonical(el.href) === request.targetUrl && (el.getAttribute("aria-current") === "page" || /^(Threads|Posts|串文|貼文)$/i.test(name(el)));
      } catch {
        return false;
      }
    });
    return tabs.length === 1 ? tabs[0] : void 0;
  }
  function actionControls(request, scope) {
    const found = controls(scope);
    if (!["follow", "unfollow"].includes(request.kind)) return found;
    const tab = profileTab(request, scope);
    return found.filter((el) => !el.closest('aside,nav,[role="complementary"],[role="navigation"],article,[data-pagelet*="timeline"]') && (!tab || precedes(el, tab)));
  }
  function assertOwnPost(request, card, expectedAccount) {
    const author = new URL(request.targetUrl).pathname.match(/^\/@([\w.]+)\/post\//)?.[1]?.toLowerCase();
    const profile = `https://www.threads.com/@${expectedAccount}`;
    const authorLinks = [...card.querySelectorAll("a[href]")].filter(isVisible).filter((link) => {
      try {
        return canonical(link.href) === profile;
      } catch {
        return false;
      }
    });
    if (author !== expectedAccount || !authorLinks.length) fail3("OWN_POST_REQUIRED", "Deletion requires the exact current-account post permalink and a visible matching author profile link in that post card.");
  }
  function currentState(request, scope) {
    const buttons = actionControls(request, scope);
    if (["follow", "unfollow"].includes(request.kind)) {
      const following = buttons.filter((el) => /^(Following|追蹤中|Unfollow|取消追蹤)$/i.test(name(el)));
      const follow = buttons.filter((el) => matchers.follow.test(name(el)));
      const requested = buttons.filter((el) => /^(Requested|已發送邀請|已要求追蹤)$/i.test(name(el)));
      if (following.length === 1 && !follow.length && !requested.length) return "unfollow";
      if (requested.length === 1 && !following.length && !follow.length) return "follow-requested";
      if (following.length + follow.length + requested.length !== 1) return "unknown";
    }
    const own = buttons.filter((el) => matchers[request.kind]?.test(name(el)));
    const opposite = buttons.filter((el) => matchers[inverse[request.kind]]?.test(name(el)));
    if (own.length === 1 && opposite.length === 0) return request.kind;
    if (opposite.length === 1 && own.length === 0) return inverse[request.kind];
    return "unknown";
  }
  function observation(request, scope, observedContext) {
    const ctx = observedContext ?? context(request);
    const state = scope ? currentState(request, scope) : "unknown";
    return { ...ctx, targetUrl: request.targetUrl, state, verified: state === inverse[request.kind], evidence: scope ? ["Unique exact-target DOM scope", "Visible action label identifies the current toggle state"] : [] };
  }
  async function waitFor(read, code = "UI_NOT_READY") {
    for (let i = 0; i < 8; i++) {
      const value = read();
      if (value !== void 0) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return fail3(code, "The expected unique UI did not appear; inspect it before another preparation.");
  }
  async function settledMenuTarget(request, pattern, expectedGeneration, expectedAccount) {
    let previousCard;
    let previousOpener;
    let previousFingerprint = "";
    let quietSince = Date.now();
    let observer;
    const deadline = Date.now() + 8e3;
    try {
      while (Date.now() < deadline) {
        assertGeneration(expectedGeneration);
        if (context(request).account !== expectedAccount) fail3("ACCOUNT_MISMATCH", "The account changed while waiting for the target post to settle.");
        if (overlays().length) fail3("EXISTING_OVERLAY", "A menu or dialog appeared before the target post settled.");
        try {
          const card = postCard(request.targetUrl);
          if (request.kind === "delete") assertOwnPost(request, card, expectedAccount);
          const opener = only(controls(card).filter((el) => pattern.test(name(el)) && /^(true|menu|dialog)$/.test(el.getAttribute("aria-haspopup") || "")), "An explicit, unique menu trigger is required for this action.", "AMBIGUOUS_UI_MENU_TRIGGER");
          const mark = fingerprint2(opener);
          if (card !== previousCard || opener !== previousOpener || mark !== previousFingerprint) {
            observer?.disconnect();
            quietSince = Date.now();
            previousCard = card;
            previousOpener = opener;
            previousFingerprint = mark;
            observer = new MutationObserver(() => {
              quietSince = Date.now();
            });
            observer.observe(card, { subtree: true, childList: true, characterData: true, attributes: true });
          }
          const loading = [card, ...card.querySelectorAll('[role="progressbar"],[aria-busy="true"],[aria-label]')].filter(isVisible).some((el) => el.getAttribute("role") === "progressbar" || el.getAttribute("aria-busy") === "true" || /^(Loading|載入中)(?:\.{3}|…)?$/i.test(el.getAttribute("aria-label") || ""));
          if (loading || opener.matches(':disabled,[aria-disabled="true"]')) quietSince = Date.now();
          else if (Date.now() - quietSince >= 600) return { card, opener };
        } catch (error) {
          if (!/^AMBIGUOUS_UI_(POST_SCOPE|MENU_TRIGGER):/.test(String(error.message))) throw error;
          observer?.disconnect();
          observer = void 0;
          previousCard = void 0;
          previousOpener = void 0;
          quietSince = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return fail3("UI_NOT_READY_MENU_TARGET", "The exact post and its unique menu trigger did not settle before the preparation deadline. No menu click was dispatched.");
    } finally {
      observer?.disconnect();
    }
  }
  async function menuFor(request, expectedGeneration) {
    assertGeneration(expectedGeneration);
    const expectedAccount = context(request).account;
    if (overlays().length) fail3("EXISTING_OVERLAY", "Close the existing menu/dialog before staging another social action.");
    const pattern = ["repost", "unrepost", "quote"].includes(request.kind) ? /^(Repost|轉發)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i : /^(More|More options|更多|更多選項)$/i;
    const { card, opener } = await settledMenuTarget(request, pattern, expectedGeneration, expectedAccount);
    assertGeneration(expectedGeneration);
    if (context(request).account !== expectedAccount) fail3("ACCOUNT_MISMATCH", "The account changed before opening its action menu.");
    if (overlays().length) fail3("EXISTING_OVERLAY", "A menu or dialog appeared before the prepared menu click.");
    if (!card.isConnected || postCard(request.targetUrl) !== card) fail3("TARGET_CHANGED_MENU_CARD", "The settled exact post changed before its menu was opened.");
    if (request.kind === "delete") assertOwnPost(request, card, expectedAccount);
    if (!isVisible(opener) || !card.contains(opener) || !pattern.test(name(opener))) fail3("TARGET_CHANGED_MENU_TRIGGER", "The settled menu trigger changed before it was opened.");
    opener.click();
    const menu = await waitFor(() => {
      assertGeneration(expectedGeneration);
      if (context(request).account !== expectedAccount) fail3("ACCOUNT_MISMATCH", "The account changed while opening its action menu.");
      if (!card.isConnected) fail3("TARGET_CHANGED_MENU_CARD", "The original post card was removed while opening its action menu.");
      if (!opener.isConnected || !card.contains(opener)) fail3("TARGET_CHANGED_MENU_TRIGGER", "The original menu trigger was removed from its post card.");
      const found = overlays();
      if (found.length !== 1) return;
      const candidate = found[0];
      const controlledId = opener.getAttribute("aria-controls");
      if (controlledId && !controlledId.split(/\s+/).includes(candidate.id)) return;
      const ready = request.kind === "quote" ? controls(candidate).filter((el) => /^(Quote|Quote post|引用|引用貼文)$/i.test(name(el))).length === 1 : currentState(request, candidate) !== "unknown";
      return ready ? candidate : void 0;
    }, "AMBIGUOUS_UI_MENU_CONTENT");
    assertGeneration(expectedGeneration);
    context(request);
    if (!card.isConnected) fail3("TARGET_CHANGED_MENU_CARD", "The target card changed while opening its menu.");
    return { menu, card };
  }
  function editorValue(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
  }
  function editors(scope) {
    return [...scope.querySelectorAll('textarea,[contenteditable="true"][role="textbox"],[contenteditable="true"][data-lexical-editor="true"]')].filter(isVisible);
  }
  function attachmentScope2(scope, editor) {
    const body = editor?.closest('[data-barcelona-composer-body="true"]');
    return body && scope.contains(body) ? body : scope;
  }
  function hasAttachments(scope, editor) {
    scope = attachmentScope2(scope, editor);
    return [...scope.querySelectorAll('input[type="file"]')].some((input) => !!input.files?.length) || !!scope.querySelector('video,img[src^="blob:"]') || [...scope.querySelectorAll("[aria-label]")].some((el) => /^(Remove|Delete|移除|刪除)\s*(media|image|photo|video|attachment|圖片|相片|影片|附件)/i.test(el.getAttribute("aria-label") || ""));
  }
  function bodyText(scope) {
    return [...scope.querySelectorAll('[dir="auto"],p')].filter(isVisible).filter((el) => !el.closest('a,button,[role="button"],time,svg,[contenteditable],h1,h2') && !el.querySelector('[dir="auto"],p,button,[role="button"],time,[contenteditable],a[href^="/@"]')).map((el) => normalizedName(el.innerText)).filter(Boolean).join(" ");
  }
  function targetEvidence(scope, targetUrl) {
    const author = new URL(targetUrl).pathname.match(/^\/@([\w.]+)\/post\//)?.[1]?.toLowerCase();
    const timestamps = [...scope.querySelectorAll("time[datetime]")].filter(isVisible).map((el) => el.getAttribute("datetime"));
    const body = bodyText(scope);
    if (!author || timestamps.length !== 1 || !Number.isFinite(Date.parse(timestamps[0])) || !body) return;
    if (![...scope.querySelectorAll("a[href]")].filter(isVisible).some((el) => {
      try {
        return canonical(el.href) === `https://www.threads.com/@${author}`;
      } catch {
        return false;
      }
    })) return;
    return { author, timestamp: timestamps[0], body };
  }
  function matchingReplyPreview(scope, editor, targetUrl, expected) {
    if (!expected || ![...scope.querySelectorAll('h1,h2,[role="heading"]')].some((el) => /^(Reply|回覆)$/i.test(normalizedName(el.textContent)))) return;
    const found = /* @__PURE__ */ new Set();
    for (const time of [...scope.querySelectorAll("time[datetime]")].filter(isVisible)) {
      if (time.getAttribute("datetime") !== expected.timestamp || !precedes(time, editor)) continue;
      let node = time.parentElement;
      while (node && scope.contains(node) && !node.contains(editor)) {
        const evidence = targetEvidence(node, targetUrl);
        if (evidence && JSON.stringify(evidence) === JSON.stringify(expected)) {
          found.add(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return found.size === 1 ? [...found][0] : void 0;
  }
  function textMatches(card, text2) {
    return [...card.querySelectorAll('p,[dir="auto"]')].filter(isVisible).some((el) => el.innerText.replace(/\r\n/g, "\n") === text2.replace(/\r\n/g, "\n"));
  }
  async function openEmptyComposer(request, expectedGeneration, expectedAccount) {
    const check2 = () => {
      assertGeneration(expectedGeneration);
      if (context(request).account !== expectedAccount) fail3("ACCOUNT_MISMATCH", "The account changed while opening the composer.");
    };
    check2();
    if (overlays().length || editors(document).some((el) => editorValue(el).trim() || hasAttachments(el.parentElement, el))) fail3("EXISTING_DRAFT", "An existing draft or dialog is present; leave it intact and resolve it manually.");
    let targetScope, expectedReply;
    if (request.kind === "publish") {
      only(controls(document).filter((el) => /^(Create|New thread|新增|建立|新串文)$/i.test(name(el))), "A unique new-thread control is required.").click();
    } else {
      const card = postCard(request.targetUrl);
      targetScope = card;
      if (request.kind === "reply") {
        expectedReply = targetEvidence(card, request.targetUrl);
        only(controls(card).filter((el) => /^(Reply|Replied|回覆|已回覆)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i.test(name(el))), "A unique Reply control in the exact target post is required.").click();
      } else {
        const binding = await menuFor(request, expectedGeneration);
        targetScope = binding.card;
        check2();
        only(controls(binding.menu).filter((el) => /^(Quote|Quote post|引用|引用貼文)$/i.test(name(el))), "A unique Quote menu action is required.").click();
      }
    }
    const scope = await waitFor(() => {
      check2();
      const dialogs = overlays().filter((el) => el.getAttribute("role") === "dialog" && editors(el).length === 1);
      return dialogs.length === 1 ? dialogs[0] : void 0;
    });
    check2();
    const editor = only(editors(scope), "The composer needs exactly one text editor.");
    if (editorValue(editor).trim()) fail3("EXISTING_DRAFT", "The opened composer contains a draft; it was not replaced.");
    if (hasAttachments(scope, editor)) fail3("EXISTING_MEDIA", "Existing composer media was not authorized.");
    let replyPreview;
    if (request.kind !== "publish" && !links(scope).some((link) => link.url === request.targetUrl)) {
      const preview = request.kind === "reply" ? matchingReplyPreview(scope, editor, request.targetUrl, expectedReply) : void 0;
      if (!preview || !expectedReply) fail3("TARGET_UNVERIFIED", "The composer needs an exact target permalink or a reply preview matching the original post.");
      replyPreview = { element: preview, evidence: expectedReply };
    }
    return { request: { kind: request.kind, targetUrl: request.targetUrl }, account: expectedAccount, scope, editor, targetScope, replyPreview };
  }
  async function openMediaComposer(input, expectedAccount) {
    if (!input || !["publish", "reply", "quote"].includes(input.kind) || typeof input.targetUrl !== "string") fail3("INVALID_INPUT", "A fixed publish, reply or quote target is required.");
    const request = requestChecked(input, true);
    if (context(request).account !== expectedAccount.toLowerCase()) fail3("ACCOUNT_MISMATCH", "The selected account does not match.");
    cancelSocialActions();
    const expectedGeneration = generation2;
    watchManualTakeover2(expectedGeneration);
    try {
      return await openEmptyComposer(request, expectedGeneration, expectedAccount.toLowerCase());
    } finally {
      if (generation2 === expectedGeneration) cancelSocialActions();
    }
  }
  function assertMediaComposerBinding(binding, request) {
    if (request && (request.kind !== binding.request.kind || request.targetUrl !== binding.request.targetUrl)) fail3("MEDIA_TARGET_MISMATCH", "The staged media belongs to another publication target.");
    if (context(binding.request).account !== binding.account) fail3("ACCOUNT_MISMATCH", "The selected account changed.");
    const { scope, editor } = binding;
    if (overlays().length !== 1 || overlays()[0] !== scope || !isVisible(scope) || !isVisible(editor) || !scope.contains(editor) || editors(scope).length !== 1 || editors(scope)[0] !== editor)
      fail3("MEDIA_COMPOSER_CHANGED", "The original media composer changed.");
    if (binding.request.kind !== "publish" && !links(scope).some((link) => link.url === binding.request.targetUrl)) {
      if (!binding.targetScope?.isConnected || !binding.replyPreview || matchingReplyPreview(scope, editor, binding.request.targetUrl, binding.replyPreview.evidence) !== binding.replyPreview.element)
        fail3("TARGET_CHANGED", "The original reply preview or quote target changed.");
    }
  }
  async function socialStage(input) {
    const request = requestChecked(input);
    const ctx = context(request);
    cancelSocialActions();
    const expectedGeneration = generation2;
    watchManualTakeover2(expectedGeneration);
    try {
      const beforeUrls = new Set(links().map((link) => link.url));
      let scope;
      let targetScope;
      let element;
      let editor;
      let expectedReply;
      let replyPreview;
      const isCompose = ["publish", "reply", "quote"].includes(request.kind);
      if (isCompose) {
        if (request.mediaToken) {
          scope = only(overlays().filter((el) => el.getAttribute("role") === "dialog"), "Approved media must be in exactly one composer dialog.");
          const binding = assertApprovedMedia(request.mediaToken, scope);
          if (binding) {
            assertMediaComposerBinding(binding, request);
            targetScope = binding.targetScope;
            replyPreview = binding.replyPreview;
            expectedReply = binding.replyPreview?.evidence;
          }
        } else {
          const binding = await openEmptyComposer(request, expectedGeneration, ctx.account);
          scope = binding.scope;
          targetScope = binding.targetScope;
          replyPreview = binding.replyPreview;
          expectedReply = binding.replyPreview?.evidence;
        }
        assertGeneration(expectedGeneration);
        context(request);
        editor = only(editors(scope), "The composer needs exactly one text editor.");
        if (editorValue(editor).trim()) fail3("EXISTING_DRAFT", "The opened composer contains a draft; it was not replaced.");
        if (request.kind !== "publish" && !links(scope).some((link) => link.url === request.targetUrl)) {
          const preview = request.kind === "reply" ? matchingReplyPreview(scope, editor, request.targetUrl, expectedReply) : void 0;
          if (!preview || !expectedReply) fail3("TARGET_UNVERIFIED", "The composer needs an exact target permalink or a reply preview matching the source author, timestamp and complete visible body.");
          replyPreview = { element: preview, evidence: expectedReply };
        }
        if (!request.mediaToken && hasAttachments(scope, editor)) fail3("EXISTING_MEDIA", "Existing composer media was not authorized.");
        editor.focus();
        if (editor instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, request.text);
        else editor.textContent = request.text;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: request.text }));
        element = await waitFor(() => {
          assertGeneration(expectedGeneration);
          const bs = controls(scope).filter((el) => /^(Post|Publish|Reply|發佈|發布|回覆)$/i.test(name(el)) && !el.matches(':disabled,[aria-disabled="true"]'));
          return bs.length === 1 ? bs[0] : void 0;
        });
        assertGeneration(expectedGeneration);
        if (editorValue(editor) !== request.text) fail3("DRAFT_NOT_ACCEPTED", "The composer did not retain the exact requested text.");
      } else {
        if (overlays().length) fail3("EXISTING_OVERLAY", "Close the existing menu/dialog before staging a social action.");
        scope = ["follow", "unfollow"].includes(request.kind) ? profileScope(request) : postCard(request.targetUrl);
        targetScope = scope;
        if (request.kind === "delete") assertOwnPost(request, scope, ctx.account);
        const needsMenu = ["save", "unsave", "repost", "unrepost", "delete"].includes(request.kind);
        if (needsMenu) {
          const binding = await menuFor(request, expectedGeneration);
          scope = binding.menu;
          targetScope = binding.card;
        }
        assertGeneration(expectedGeneration);
        const state = currentState(request, scope);
        if (state === "unknown") fail3("AMBIGUOUS_UI_ACTION_STATE", "The exact target has conflicting or unknown action state; no action was staged.");
        if (state !== inverse[request.kind]) element = only(actionControls(request, scope).filter((el) => matchers[request.kind].test(name(el))), "The exact desired action is not uniquely available. No toggle was dispatched.", "AMBIGUOUS_UI_ACTION_CONTROL");
      }
      assertGeneration(expectedGeneration);
      const before = observation(request, scope);
      const entry = {
        token: crypto.randomUUID(),
        ...ctx,
        request,
        before,
        noop: !isCompose && before.verified,
        element,
        fingerprint: element ? fingerprint2(element) : void 0,
        scope,
        targetScope,
        editor,
        replyPreview,
        beforeUrls,
        expires: Date.now() + 9e4,
        consumed: false
      };
      staged = entry;
      expiryTimer = window.setTimeout(() => {
        if (generation2 === expectedGeneration) cancelSocialActions();
      }, Math.max(0, entry.expires - Date.now()));
      return { token: entry.token, account: entry.account, url: entry.url, request, before, noop: entry.noop };
    } catch (error) {
      if (generation2 === expectedGeneration) cancelSocialActions();
      throw error;
    }
  }
  function socialCommit(token, expectedAccount) {
    const entry = staged;
    if (!entry || entry.token !== token || entry.consumed) fail3("INVALID_ACTION", "The browser preparation is absent or consumed.");
    entry.consumed = true;
    if (Date.now() > entry.expires) fail3("EXPIRED_ACTION", "Prepare from current UI again.");
    const ctx = context(entry.request);
    if (ctx.account !== entry.account || expectedAccount.replace(/^@/, "").toLowerCase() !== entry.account) fail3("ACCOUNT_MISMATCH", "The signed-in account changed.");
    if (!entry.scope?.isConnected || !isVisible(entry.scope)) fail3("TARGET_CHANGED", "The staged UI scope changed.");
    if (overlays().some((overlay) => overlay !== entry.scope)) fail3("UI_CHANGED", "Another dialog or menu opened after preparation.");
    if (entry.targetScope && !entry.editor) {
      const target = ["follow", "unfollow"].includes(entry.request.kind) ? profileScope(entry.request) : postCard(entry.request.targetUrl);
      if (target !== entry.targetScope) fail3("TARGET_CHANGED", "The exact target card or header changed after staging.");
      if (entry.request.kind === "delete") assertOwnPost(entry.request, target, entry.account);
    }
    if (entry.noop) {
      if (!observation(entry.request, entry.scope).verified) fail3("STATE_CHANGED", "The desired state changed since preparation.");
      return { dispatched: false, noop: true };
    }
    const el = entry.element;
    if (!isVisible(el) || !entry.scope.contains(el) || fingerprint2(el) !== entry.fingerprint || el.matches(':disabled,[aria-disabled="true"]')) fail3("STALE_ELEMENT", "The staged control changed; no input was dispatched.");
    if (entry.editor && (!isVisible(entry.editor) || !entry.scope.contains(entry.editor) || editorValue(entry.editor) !== entry.request.text)) fail3("DRAFT_CHANGED", "The exact staged draft changed.");
    if (entry.editor) {
      if (entry.request.mediaToken) assertApprovedMedia(entry.request.mediaToken, entry.scope);
      else if (hasAttachments(entry.scope, entry.editor)) fail3("MEDIA_CHANGED", "Unexpected composer media appeared after preparation.");
    }
    if (entry.editor && entry.request.kind !== "publish" && !links(entry.scope).some((link) => link.url === entry.request.targetUrl)) {
      if (!entry.targetScope?.isConnected || !entry.replyPreview || matchingReplyPreview(entry.scope, entry.editor, entry.request.targetUrl, entry.replyPreview.evidence) !== entry.replyPreview.element)
        fail3("TARGET_CHANGED", "The composer target preview changed after preparation.");
    }
    entry.committedAt = Date.now();
    el.click();
    return { dispatched: true, noop: false };
  }
  async function socialInspect(input, token) {
    const expectedGeneration = generation2;
    const inspected = requestChecked(input, true);
    const entry = staged && staged.token === token && staged.consumed && staged.request.kind === inspected.kind && staged.request.targetUrl === inspected.targetUrl ? staged : void 0;
    if (token !== void 0 && !entry) fail3("ACTION_CANCELLED", "The committed action evidence was cancelled or is unavailable; inspect without a token only for an unattributed current-state observation.");
    const request = entry?.request ?? inspected;
    const ctx = { url: canonical(location.href), account: account2() };
    if (entry && ctx.account !== entry.account) fail3("ACCOUNT_MISMATCH", "The account changed after dispatch.");
    if (ctx.url !== request.targetUrl) {
      const ownNewPostRoute = !!entry?.committedAt && ["publish", "reply", "quote"].includes(request.kind) && !entry.beforeUrls.has(ctx.url) && new URL(ctx.url).pathname.startsWith(`/@${ctx.account}/post/`) && /^\/@[\w.]+\/post\/[\w-]+$/.test(new URL(ctx.url).pathname);
      if (!ownNewPostRoute) fail3("TARGET_CHANGED", "The current page is neither the prepared target nor a new own-post route after commit.");
    }
    if (["publish", "reply", "quote"].includes(request.kind)) {
      const result = observation(request, void 0, ctx);
      if (!entry) return result;
      const newLinks = [...new Set(links().map((link) => link.url))].filter((url) => !entry.beforeUrls.has(url) && new URL(url).pathname.startsWith(`/@${ctx.account}/post/`));
      const matches = newLinks.filter((url) => {
        try {
          const card = postCard(url);
          const timestamp = card.querySelector("time[datetime]")?.getAttribute("datetime");
          const created = timestamp ? Date.parse(timestamp) : NaN;
          return textMatches(card, request.text) && !!entry.committedAt && Number.isFinite(created) && created >= entry.committedAt - 2e3 && created <= Date.now() + 2e3;
        } catch {
          return false;
        }
      });
      if (request.kind === "publish" && !request.mediaToken && matches.length === 1) return { ...result, state: "published", verified: true, postUrl: matches[0], evidence: ["New visible permalink absent before commit", "Exact current account author", "Exact visible submitted text", "Visible creation timestamp within the commit window"] };
      if (request.mediaToken && matches.length === 1) return { ...result, state: "publication-observed-media-unverified", postUrl: matches[0], evidence: ["New exact-text post observed, but uploaded media bytes cannot be matched to the rendered remote attachments"] };
      return { ...result, state: matches.length ? "new-post-observed-relation-unverified" : "publication-unverified", evidence: matches.length ? ["New exact-text post observed, but reply/quote relationship is not established"] : [] };
    }
    if (request.kind === "delete") {
      if (entry && overlays().some((overlay) => overlay !== entry.scope)) return {
        ...ctx,
        targetUrl: request.targetUrl,
        state: "confirmation-required",
        verified: false,
        evidence: ["The exact own-post Delete menu item was dispatched once", "A new dialog or menu is visible; no confirmation was clicked"]
      };
      let card;
      try {
        card = postCard(request.targetUrl);
      } catch (error) {
        if (!entry) throw error;
      }
      if (card) assertOwnPost(request, card, ctx.account);
      return {
        ...ctx,
        targetUrl: request.targetUrl,
        state: card ? "own-post-observed" : "deletion-unverified",
        verified: false,
        evidence: card ? ["The exact own-account post remains visible"] : ["The target post is no longer visible; absence alone does not prove deletion"]
      };
    }
    let scope = ["follow", "unfollow"].includes(request.kind) ? profileScope(request) : postCard(request.targetUrl);
    if (entry && request.kind === "unfollow" && overlays().length) return { ...observation(request, scope), verified: false, state: "confirmation-required", evidence: ["The authorized Following/Unfollow control was dispatched once", "A dialog or menu is now visible; its confirmation has not been dispatched"] };
    if (["save", "unsave", "repost", "unrepost"].includes(request.kind)) {
      if (entry?.scope && isVisible(entry.scope)) scope = entry.scope;
      else if (entry) {
        scope = (await menuFor(request, expectedGeneration)).menu;
        assertGeneration(expectedGeneration);
        entry.scope = scope;
      } else return { ...ctx, targetUrl: request.targetUrl, state: "menu-required", verified: false, evidence: [] };
    }
    return observation(request, scope);
  }

  // src/page-runtime.ts
  function directProfile2(args) {
    return directProfile(args, { viewer: () => viewer().username, guard: guard2 });
  }
  var runtimeVersion = "0.6.0";
  var runtimeRevision = "20261106-remote-media-1";
  var current;
  function routeKey(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }
  var lastObservedRoute = routeKey(location.href);
  var observedRouteChange = false;
  var attachedAfterDocumentStarted = document.readyState !== "loading";
  function rendered(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
  }
  function visible2(el) {
    return el instanceof HTMLElement && rendered(el) && !el.closest('[aria-hidden="true"],[inert]');
  }
  function visibleDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].filter((el) => visible2(el) && !el.closest('[aria-hidden="true"]')).at(-1);
  }
  var connectionTabPattern = /^(?:Followers|Following|粉絲|追蹤者|追蹤中)(?:\s*[(（]?[\d,.]+(?:[kmb萬億千])?[)）]?)?$/i;
  var connectionSession;
  function clearConnectionSession() {
    connectionSession?.observer.disconnect();
    connectionSession = void 0;
  }
  function selectedDialogTab(dialog) {
    const tabs = [...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible2);
    return tabs.length === 1 ? label(tabs[0]).replace(/\s+/g, " ").trim() || null : null;
  }
  function connectionTabIdentity(tab) {
    return tab && connectionTabPattern.test(tab) ? /^(?:Following|追蹤中)/i.test(tab) ? "following" : "followers" : null;
  }
  function connectionRows(dialog) {
    return [...dialog.querySelectorAll("a[href]")].filter((a) => visible2(a) && a.protocol === "https:" && ["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(a.hostname) && !a.port && !a.username && !a.password && /^\/@[\w.]+\/?$/.test(a.pathname) && !a.closest('[role="tablist"]')).map((node) => ({ node, href: node.href }));
  }
  function sameConnectionRows(a, b) {
    return a.length === b.length && a.every((row, index) => row.node === b[index]?.node && row.href === b[index]?.href);
  }
  function connectionRowsReplaced(a, b) {
    return a.length === 0 ? b.length > 0 : a.every((old) => !b.some((row) => row.node === old.node && row.href === old.href));
  }
  function loadingIndicators(scope) {
    return [scope, ...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"],[aria-label]')].filter((el) => (el.matches('[aria-busy="true"],[role="progressbar"]') || /^(?:Loading|載入中|正在載入)[\s.…]*$/i.test(el.getAttribute("aria-label") || "")) && rendered(el) && !el.closest('[aria-hidden="true"],[inert]'));
  }
  function connectionPaginationIndicator(el, tab, rows) {
    if (!tab || !connectionTabPattern.test(tab) || !rows.length || el.matches('[aria-busy="true"],[role="progressbar"]')) return false;
    const status = el.closest('[role="status"]');
    return !!status && !status.closest('button,[role="button"],a') && !!status.parentElement && rows.every((row) => !status.parentElement.contains(row.node) && !!(row.node.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  function dialogLoading(dialog, tab) {
    const indicators = loadingIndicators(dialog);
    const rows = tab && connectionTabPattern.test(tab) ? connectionRows(dialog) : [];
    const pagination = indicators.filter((el) => connectionPaginationIndicator(el, tab, rows));
    return { indicators, pagination, blocking: indicators.some((el) => !pagination.includes(el)) };
  }
  function updateConnectionSession(session, records) {
    if (connectionSession !== session) return;
    const closed = records.some((record) => record.type === "childList" && [...record.removedNodes].some((node) => node === session.dialog || node.contains(session.dialog)) || record.type === "attributes" && (record.target === session.dialog || record.target.contains(session.dialog)) && (record.attributeName === "aria-hidden" && record.oldValue === "true" || ["hidden", "inert"].includes(record.attributeName || "") && record.oldValue !== null || record.attributeName === "style" && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(record.oldValue || "")));
    if (closed || !session.dialog.isConnected || !visible2(session.dialog) || routeKey(location.href) !== session.route) {
      clearConnectionSession();
      return;
    }
    const tabLabel = selectedDialogTab(session.dialog), tab = connectionTabIdentity(tabLabel), rows = connectionRows(session.dialog), now = Date.now();
    const selections = records.map((record, index) => ({ record, index })).filter(({ record }) => record.type === "attributes" && record.attributeName === "aria-selected" && record.target instanceof Element && session.dialog.contains(record.target) && record.target.matches('[role="tab"]'));
    const activations = selections.filter(({ record, index }) => {
      const next = selections.find((item) => item.index > index && item.record.target === record.target);
      return (next ? next.record.oldValue : record.target.getAttribute("aria-selected")) === "true" && record.oldValue !== "true";
    });
    const blocking = loadingIndicators(session.dialog).some((el) => el.matches('[aria-busy="true"],[role="progressbar"]'));
    const changed = !sameConnectionRows(session.rows, rows), replaced = connectionRowsReplaced(session.rows, rows);
    if (activations.length || tab !== session.tab) {
      const cycle = activations.length > 1 || tab === session.tab;
      session.pending = { from: session.tab, target: tab, baseline: cycle ? rows : session.rows, changed: replaced && !cycle, sawBlocking: blocking, blockingObserved: blocking, quietSince: now };
    } else if (session.pending) {
      if (changed) {
        session.pending.changed ||= connectionRowsReplaced(session.pending.baseline, rows);
        session.pending.quietSince = now;
      }
      if (blocking) {
        session.pending.sawBlocking = true;
        session.pending.blockingObserved = true;
      } else if (session.pending.sawBlocking) {
        session.pending.changed = true;
        session.pending.sawBlocking = false;
        session.pending.quietSince = now;
      }
    }
    session.tab = tab;
    session.rows = rows;
  }
  function connectionTransitionBusy(dialog, tabLabel, blocking) {
    const tab = connectionTabIdentity(tabLabel);
    if (!tab) return false;
    let session = connectionSession;
    if (session?.dialog !== dialog || session.route !== routeKey(location.href)) {
      clearConnectionSession();
      const observer = new MutationObserver((records) => {
        if (connectionSession) updateConnectionSession(connectionSession, records);
      });
      session = { dialog, route: routeKey(location.href), tab, rows: connectionRows(dialog), observer };
      connectionSession = session;
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["aria-selected", "href", "aria-busy", "aria-label", "hidden", "aria-hidden", "inert", "style", "class"] });
    } else updateConnectionSession(session, session.observer.takeRecords());
    if (connectionSession !== session) return true;
    const pending = session.pending;
    if (!pending) return false;
    const turnover = connectionRowsReplaced(pending.baseline, session.rows), loadCompleted = pending.blockingObserved && !pending.sawBlocking;
    if (pending.target !== tab || !pending.changed || !turnover && !loadCompleted || blocking || Date.now() - pending.quietSince < 500) return true;
    session.pending = void 0;
    return false;
  }
  function readDialogState(dialog) {
    if (!dialog) {
      clearConnectionSession();
      return { present: false, selectedTab: null, busy: false };
    }
    const selectedTab = selectedDialogTab(dialog), evidence = dialogLoading(dialog, selectedTab);
    return { present: true, selectedTab, busy: connectionTransitionBusy(dialog, selectedTab, evidence.blocking) || evidence.blocking };
  }
  var activityDiagnostic;
  function busyIndicators(scope) {
    const profiles = [...scope.querySelectorAll("a[href]")].filter((link) => visible2(link) && /^\/@[\w.]+\/?$/.test(link.pathname));
    const indicators = loadingIndicators(scope), tab = selectedDialogTab(scope), rows = connectionRows(scope);
    return { total: indicators.length, profileLinks: profiles.length, transitionPending: connectionSession?.dialog === scope && !!connectionSession.pending, indicators: indicators.slice(0, 8).map((el) => {
      const rect = el.getBoundingClientRect();
      const ancestors = [];
      let parent = el.parentElement;
      for (let depth = 0; parent && parent !== scope && depth < 4; depth++, parent = parent.parentElement) ancestors.push({ tag: parent.tagName, role: parent.getAttribute("role"), profileLinks: profiles.filter((link) => parent.contains(link)).length });
      return {
        tag: el.tagName,
        role: el.getAttribute("role"),
        label: el.getAttribute("aria-label"),
        explicit: el.matches('[aria-busy="true"],[role="progressbar"]'),
        paginationCandidate: connectionPaginationIndicator(el, tab, rows),
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
        withinViewport: rect.bottom > 0 && rect.top < innerHeight,
        profileLinksBefore: profiles.filter((link) => !!(link.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)).length,
        profileLinksAfter: profiles.filter((link) => !!(link.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)).length,
        ancestors
      };
    }) };
  }
  function runtimeDiagnostics(dialog) {
    const activity = activityDiagnostic && activityDiagnostic.url === location.href ? activityDiagnostic : void 0;
    const connection = connectionSession?.dialog === dialog ? connectionSession : void 0, pending = connection?.pending;
    return { dialog: dialog ? { ...busyIndicators(dialog), transition: {
      pending: !!pending,
      from: pending?.from ?? null,
      to: pending?.target ?? null,
      oldRowCount: pending?.baseline.length ?? 0,
      stillConnectedOldRowCount: pending?.baseline.filter((row) => row.node.isConnected && visible2(row.node) && row.node.href === row.href).length ?? 0,
      currentRowCount: connection?.rows.length ?? 0,
      sawBlockingLoad: pending?.blockingObserved ?? false
    } } : null, activity: activity ? {
      stage: activity.stage,
      dispatches: activity.dispatches,
      quietMs: activity.quietMs,
      regionConnected: !!activity.region?.isConnected,
      controlConnected: !!activity.control?.isConnected,
      control: activity.control ? { tag: activity.control.tagName, role: activity.control.getAttribute("role"), label: label(activity.control), disabled: activity.control.matches(':disabled,[aria-disabled="true"]') } : null,
      region: activity.region?.isConnected ? busyIndicators(activity.region) : null
    } : null };
  }
  function label(el) {
    const clean = (value) => (value || "").trim().replace(/\s+/g, " ");
    const explicit = clean(el.getAttribute("aria-label"));
    if (explicit) return explicit.slice(0, 250);
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id2) => document.getElementById(id2)?.textContent || "").join(" ");
    if (clean(labelledBy)) return clean(labelledBy).slice(0, 250);
    const iconNames = [];
    for (const icon of el.querySelectorAll("svg")) {
      if (icon.closest('button,[role="button"],[role="menuitem"],a') !== el || !rendered(icon) || icon.closest('[aria-hidden="true"],[inert]')) continue;
      const aria = clean(icon.getAttribute("aria-label"));
      if (aria) {
        iconNames.push(aria);
        continue;
      }
      const titles = [clean(icon.getAttribute("title")), ...[...icon.children].filter((child) => child.localName === "title").map((child) => clean(child.textContent))].filter(Boolean);
      if (new Set(titles).size > 1) return "";
      if (titles[0]) iconNames.push(titles[0]);
    }
    if (iconNames.length > 1) return "";
    return (iconNames[0] || clean(el.getAttribute("placeholder")) || clean(el.innerText)).slice(0, 250);
  }
  function context2(el) {
    return (el.parentElement?.parentElement?.innerText || "").slice(0, 500);
  }
  function nearbyEditorState(el) {
    let scope = el.parentElement;
    for (let depth = 0; scope && scope !== document.body && depth < 6; depth++, scope = scope.parentElement) {
      const editors2 = [...scope.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible2);
      if (editors2.length) return editors2.map((editor) => editor instanceof HTMLTextAreaElement ? editor.value : editor.innerHTML);
      if (scope.matches('main,[role="main"]')) break;
    }
    return null;
  }
  function fingerprint3(el) {
    const state = el instanceof HTMLInputElement ? /password|file|hidden/i.test(el.type) ? null : [el.value, el.checked] : el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.isContentEditable ? el.innerHTML : null;
    return JSON.stringify([el.tagName, el.getAttribute("role"), label(el), el.getAttribute("href"), context2(el), state, nearbyEditorState(el), el.getAttribute("aria-pressed"), el.getAttribute("aria-expanded"), el.getAttribute("aria-disabled")]);
  }
  function guard2() {
    if (!["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(location.hostname) || location.protocol !== "https:") throw new Error("WRONG_PAGE: Only Threads pages are supported.");
    const route = routeKey(location.href);
    if (route !== lastObservedRoute) {
      observedRouteChange = true;
      lastObservedRoute = route;
      clearActivityBinding();
      clearConnectionSession();
    }
  }
  function viewer() {
    const names = [...document.querySelectorAll("a[href]")].filter(visible2).filter((a) => /^(Profile|個人檔案)$/i.test(label(a)) && !a.closest('article,[role="dialog"],[role="menu"]') && a.protocol === "https:" && ["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(a.hostname) && !a.username && !a.password && !a.port).map((a) => a.pathname.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter((value) => !!value);
    const unique = [...new Set(names)];
    return { username: unique.length === 1 ? unique[0] : null };
  }
  function interactive(scope = document) {
    return [...scope.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[role="menuitem"],[contenteditable="true"]')].filter(visible2);
  }
  function readComposerState() {
    const state = { present: false, nonempty: false, attachments: false, ambiguous: false };
    const editors2 = [...document.querySelectorAll('textarea,[contenteditable="true"],input:not([type]),input[type="text"],input[type="search"]')].filter(visible2);
    const removeMedia = (el) => /^(?:Remove|Delete|移除|刪除)(?:\s*(?:media|image|photo|video|attachment|圖片|相片|影片|附件))/i.test(label(el));
    for (const editor of editors2) {
      const name2 = [editor.getAttribute("aria-label"), editor.getAttribute("placeholder"), editor.getAttribute("aria-placeholder")].filter(Boolean).join(" ");
      if (editor.matches('input[type="search"],[role="searchbox"]') || editor.closest('[role="search"]') || /^(?:Search|搜尋|搜索)(?:\s|$)/i.test(name2)) continue;
      const dialog = editor.closest('[role="dialog"]');
      const body = editor.closest('[data-barcelona-composer-body="true"]');
      const recognized = !!body || editor.getAttribute("data-lexical-editor") === "true" || /(?:new (?:thread|post)|reply|what(?:’|')?s new|start a thread|撰寫|新貼文|新串文|回覆)/i.test(name2);
      if (!recognized) state.ambiguous = true;
      const value = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent || "";
      const nonempty = !!value.replace(/[\s\u200b\ufeff]/g, "");
      let scope = body || dialog || editor.parentElement;
      if (!body && !dialog) {
        for (let node = editor.parentElement, depth = 0; node && node !== document.body && !node.matches('main,[role="main"],article') && depth < 8; node = node.parentElement, depth++) {
          if (node.querySelectorAll('textarea,[contenteditable="true"]').length > 1) break;
          if (node.querySelector('input[type="file"],img[src^="blob:"],video[src^="blob:"]') || interactive(node).some(removeMedia)) {
            scope = node;
            break;
          }
        }
      }
      const files = scope ? [...scope.querySelectorAll('input[type="file"]')].some((input) => !!input.files?.length) : false;
      const previews = scope ? [...scope.querySelectorAll("img,video")].filter(visible2).some((el) => /^(?:blob:|data:image\/)/i.test(el.getAttribute("src") || "") || !!body && (el.tagName === "VIDEO" || !/(?:profile picture|profile photo|大頭貼|頭像)/i.test(el.getAttribute("alt") || ""))) : false;
      const attachments = files || previews || !!scope && interactive(scope).some(removeMedia);
      state.nonempty ||= nonempty;
      state.attachments ||= attachments;
      state.present ||= !!dialog || nonempty || attachments;
    }
    return state;
  }
  function snapshot() {
    guard2();
    current = { id: crypto.randomUUID(), url: location.href, expires: Date.now() + 12e4, entries: /* @__PURE__ */ new Map() };
    const elements = interactive().slice(0, 300).map((element, i) => {
      const ref = String(i + 1);
      current.entries.set(ref, { element, fingerprint: fingerprint3(element) });
      return { ref, role: element.getAttribute("role") || element.tagName.toLowerCase(), name: label(element), text: element.innerText?.slice(0, 300) || "", ...element instanceof HTMLAnchorElement ? { href: element.href } : {}, editable: element.matches('input,textarea,select,[contenteditable="true"]'), ...element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? { checked: element.checked } : {}, context: context2(element) };
    });
    return { snapshotId: current.id, url: location.href, title: document.title, viewer: viewer(), elements, text: document.body.innerText.slice(0, 24e3) };
  }
  function interact(args) {
    guard2();
    if (!current || current.id !== args.snapshotId || current.url !== location.href || Date.now() > current.expires) throw new Error("STALE_SNAPSHOT: Get a new browser snapshot before acting.");
    const entry = current.entries.get(args.ref);
    if (!entry || !entry.element.isConnected || !visible2(entry.element) || entry.fingerprint !== fingerprint3(entry.element)) throw new Error("STALE_ELEMENT: The target changed. Get a new snapshot.");
    const el = entry.element;
    if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error("DISABLED_ELEMENT: The target is disabled.");
    current = void 0;
    if (args.verb === "click") el.click();
    else if (args.verb === "fill") {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el instanceof HTMLInputElement && /password|file/i.test(el.type)) throw new Error("UNSUPPORTED_INPUT: Credentials and files require manual input.");
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, args.value || "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = args.value || "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: args.value || "" }));
      } else throw new Error("NOT_EDITABLE: Target is not a text input.");
    } else if (args.verb === "select") {
      if (!(el instanceof HTMLSelectElement)) throw new Error("NOT_SELECT: Target is not a select.");
      if (![...el.options].some((o) => o.value === args.value)) throw new Error("INVALID_OPTION: Option is not present.");
      el.value = args.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (args.verb === "check") {
      if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) throw new Error("NOT_CHECKBOX: Target is not a checkbox.");
      if (el.checked !== (args.value === "true")) el.click();
    } else if (args.verb === "press") {
      if (!["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"].includes(args.value || "")) throw new Error("UNSUPPORTED_KEY: Key is not allowed.");
      el.focus();
      const event = { key: args.value, code: args.value, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", event));
      el.dispatchEvent(new KeyboardEvent("keyup", event));
    }
    return { dispatched: true, verified: false, message: "Input dispatched. Inspect a fresh snapshot to verify the application result." };
  }
  function scrollTarget() {
    const dialog = visibleDialog();
    const scope = dialog || document;
    const options = [...scope.querySelectorAll("div,section,main")].filter((el) => visible2(el) && el.scrollHeight > el.clientHeight + 80 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    options.sort((a, b) => b.clientHeight - a.clientHeight);
    return options[0] || document.scrollingElement || document.documentElement;
  }
  function scroll(pixels) {
    guard2();
    current = void 0;
    const el = scrollTarget();
    const before = el.scrollTop;
    el.scrollBy(0, Math.max(-2200, Math.min(2200, pixels)));
    return { before, after: el.scrollTop };
  }
  async function openReadPanel(panel, activityTab) {
    guard2();
    current = void 0;
    if (panel === "likers") return openPostActivity(activityTab);
    const dialog = visibleDialog();
    if (panel === "following" && !dialog) throw new Error("UI_CHANGED: Open the follower dialog before selecting its Following tab.");
    const controls2 = interactive(dialog || document).filter((el) => panel !== "following" || el.getAttribute("role") === "tab");
    const matcher = panel === "following" && dialog ? /^(Following|追蹤中)(?:\s*[\d.,萬万KMB]+)?$/i : /(?:\d[\d.,\s萬万KMB]*\s*(followers|位粉絲)|followers\s*\d)/i;
    const matches = controls2.filter((el) => matcher.test(label(el)));
    if (matches.length !== 1) throw new Error("UI_CHANGED: Could not identify a unique read-only panel control; use a fresh browser snapshot.");
    const matched = matches[0];
    const tabButtons = matched.getAttribute("role") === "tab" ? interactive(matched).filter((el) => el.matches('button,[role="button"]')) : [];
    if (tabButtons.length > 1) throw new Error("UI_CHANGED: The selected tab contains multiple action controls.");
    if (dialog && panel === "following") readDialogState(dialog);
    (tabButtons[0] || matched).click();
    return { opened: panel, verified: false };
  }
  var activityBinding;
  function clearActivityBinding() {
    activityBinding?.observer.disconnect();
    activityBinding = void 0;
  }
  function checkActivitySession(records = []) {
    const binding = activityBinding;
    if (!binding) return;
    if (!binding.dialog.isConnected || !visible2(binding.dialog) || currentPostTarget()?.url !== binding.url) {
      clearActivityBinding();
      return;
    }
    for (const record of records) {
      if (record.type === "childList" && [...record.removedNodes].some((node) => node === binding.dialog || node.contains(binding.dialog))) {
        clearActivityBinding();
        return;
      }
      if (record.type === "attributes" && (record.target === binding.dialog || record.target.contains(binding.dialog)) && (record.attributeName === "aria-hidden" && record.oldValue === "true" || ["hidden", "inert"].includes(record.attributeName || "") && record.oldValue !== null || record.attributeName === "style" && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(record.oldValue || ""))) {
        clearActivityBinding();
        return;
      }
    }
  }
  function sessionOwns(dialog, target) {
    const binding = activityBinding;
    if (!binding) return false;
    checkActivitySession(binding.observer.takeRecords());
    if (activityBinding !== binding) return false;
    if (!binding.dialog.contains(dialog)) {
      clearActivityBinding();
      return false;
    }
    return binding.url === target.url && binding.code === target.code;
  }
  function bindActivitySession(target, dialog) {
    if (sessionOwns(dialog, target)) return;
    clearActivityBinding();
    const observer = new MutationObserver((records) => checkActivitySession(records));
    activityBinding = { ...target, dialog, observer };
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["aria-hidden", "hidden", "inert", "style", "class"] });
  }
  function currentPostTarget() {
    const match = location.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);
    return match ? { url: `https://www.threads.com/@${match[1]}/post/${match[2]}`, code: match[2] } : null;
  }
  function postActivity(dialog) {
    if (!dialog) {
      clearActivityBinding();
      return void 0;
    }
    const headings = [...dialog.querySelectorAll('h1,h2,[role="heading"]')].filter(visible2).map((el) => el.innerText.trim());
    const title = headings.find((text2) => /^(?:貼文動態|Post activity|Activity|[\d,.萬万KMB]+\s*個讚|[\d,.萬万KMB]+\s*次轉發|[\d,.KMB]+\s+(?:likes?|reposts?)|Likes|Reposts)$/i.test(text2));
    if (!title) return void 0;
    const selectedTab = /個讚$|\blikes?$/i.test(title) ? "likes" : /次轉發$|\breposts?$/i.test(title) ? "reposts" : null;
    const target = currentPostTarget();
    const codes = [...new Set([...dialog.querySelectorAll("a[href]")].filter((a) => a.protocol === "https:" && ["www.threads.com", "threads.com", "threads.net", "www.threads.net"].includes(a.hostname) && !a.port && !a.username && !a.password).flatMap((a) => {
      const match = a.pathname.match(/^\/(?:insights\/post|@[\w.]+\/post)\/([\w-]+)\/?$/);
      return match ? [match[1]] : [];
    }))];
    if (target && codes.length && (codes.length !== 1 || codes[0] !== target.code)) clearActivityBinding();
    const owned = !!target && sessionOwns(dialog, target);
    const bound = !!target && (codes.length === 1 && codes[0] === target.code || codes.length === 0 && owned);
    const busy = readDialogState(dialog).busy;
    const countFor = (re) => {
      const matches = interactive(dialog).filter((el) => el.matches('button,[role="button"],a') && re.test(el.innerText.replace(/\s+/g, "")));
      return matches.length === 1 ? parseCount(matches[0].innerText) : null;
    };
    const counts = { likes: selectedTab === "likes" ? parseCount(title) : countFor(/^(?:按讚內容|Likes)[\d,.萬万KMB]*$/i), reposts: selectedTab === "reposts" ? parseCount(title) : countFor(/^(?:轉發|Reposts?)[\d,.萬万KMB]*$/i), views: countFor(/^(?:洞察報告|Insights)[\d,.萬万KMB]+(?:次瀏覽|views)?$/i) };
    const users = /* @__PURE__ */ new Map();
    if (bound && selectedTab && !busy) for (const row of [...dialog.querySelectorAll('[data-pressable-container="true"],[role="listitem"]')].filter(visible2)) {
      if (![...row.querySelectorAll("time")].some((time) => rendered(time) && !time.closest('[aria-hidden="true"],[inert]'))) continue;
      const names = [...new Set([...row.querySelectorAll("a[href]")].filter(visible2).filter((a) => a.protocol === "https:" && ["www.threads.com", "threads.com", "threads.net", "www.threads.net"].includes(a.hostname) && !a.username && !a.password && !a.port).flatMap((a) => {
        const match = a.pathname.match(/^\/@([\w.]+)\/?$/);
        return match ? [match[1].toLowerCase()] : [];
      }))];
      if (names.length !== 1) continue;
      const username = names[0];
      users.set(username, { username, url: `https://www.threads.com/@${username}`, bio: null, followers: null, following: null, private: null, links: [] });
    }
    return {
      present: true,
      targetUrl: bound ? target.url : null,
      targetCode: bound ? target.code : null,
      selectedTab,
      users: [...users.values()],
      displayedCount: selectedTab === "likes" ? counts.likes : selectedTab === "reposts" ? counts.reposts : null,
      counts,
      busy,
      warnings: [...!bound ? ["Activity dialog target was not bound to the exact current post."] : [], ...!selectedTab ? ["The activity overview is not a selected liker or reposter list."] : [], "Only visible, structurally identified activity user rows are included; displayed totals do not prove complete collection."]
    };
  }
  function waitActivity(stage, read) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 8e3;
      let timer;
      let settled = false;
      const observer = new MutationObserver(check2);
      function finish(value, error) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }
      function check2() {
        if (settled) return;
        try {
          const value = read();
          if (value !== void 0) {
            finish(value);
            return;
          }
          if (Date.now() >= deadline) {
            finish(void 0, new Error(`ACTIVITY_${stage.toUpperCase()}_TIMEOUT: The post activity ${stage} did not become identifiable within 8 seconds.`));
            return;
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(check2, Math.min(250, deadline - Date.now()));
        } catch (error) {
          finish(void 0, error);
        }
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      check2();
    });
  }
  async function openPostActivity(activityTab) {
    const target = currentPostTarget();
    if (!target) throw new Error("INVALID_INPUT: Open the exact post permalink before its activity.");
    activityDiagnostic = { stage: "initial", dispatches: 0, quietMs: 0, region: null, control: null, url: location.href };
    let dialog = visibleDialog();
    if (!dialog) {
      const activityControl = (el) => /^(?:View activity|Post activity|查看動態|貼文動態)$/i.test(label(el));
      let stability;
      const ready = await waitActivity("readiness", () => {
        if (currentPostTarget()?.url !== target.url) throw new Error("CONTEXT_CHANGED: The post changed before activity was ready.");
        const candidates = /* @__PURE__ */ new Set();
        const links2 = [...document.querySelectorAll("a[href]")].filter(visible2).filter((a) => /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(a.pathname));
        for (const link of links2.filter((a) => a.pathname.replace(/\/$/, "") === new URL(target.url).pathname)) {
          let node = link;
          for (let depth = 0; node && node !== document.body && depth < 16; depth++, node = node.parentElement) {
            const reactions = interactive(node).filter((el) => el.matches('button,[role="button"]') && /^(?:Like|Unlike|讚|收回讚)(?:\s*\d[\d.,萬万KMB]*)?$/i.test(label(el)));
            if (reactions.length > 1) break;
            if (reactions.length === 1 && !links2.some((a) => node.contains(a) && a.pathname.replace(/\/$/, "") !== new URL(target.url).pathname)) {
              candidates.add(node);
              break;
            }
          }
        }
        const isolated = [...candidates].filter((candidate) => ![...candidates].some((other) => other !== candidate && candidate.contains(other)));
        if (isolated.length !== 1) return void 0;
        const card2 = isolated[0];
        let readyRegion = card2;
        let options2 = interactive(card2).filter(activityControl);
        if (options2.length === 0) {
          for (let region = card2.parentElement, depth = 0; region && region !== document.body && !region.matches('main,[role="main"],nav,aside') && depth < 8; region = region.parentElement, depth++) {
            if (links2.some((a) => region.contains(a) && a.pathname.replace(/\/$/, "") !== new URL(target.url).pathname)) break;
            const reactions = interactive(region).filter((el) => el.matches('button,[role="button"]') && /^(?:Like|Unlike|讚|收回讚)(?:\s*\d[\d.,萬万KMB]*)?$/i.test(label(el)));
            if (reactions.length !== 1) break;
            const adjacent = interactive(region).filter(activityControl);
            if (adjacent.length) {
              options2 = adjacent;
              readyRegion = region;
              break;
            }
          }
        }
        if (options2.length > 1) throw new Error("UI_CHANGED: Multiple activity controls were found in the exact-post region.");
        const control = options2[0] ?? interactive(card2).find((el) => /^(?:More|More options|更多|更多選項)$/i.test(label(el)) && /^(?:menu|true)$/.test(el.getAttribute("aria-haspopup") || "")) ?? null;
        const signature = control ? JSON.stringify([control.tagName, control.getAttribute("role"), label(control), control.getAttribute("aria-disabled"), control.getAttribute("disabled")]) : "";
        if (!stability || stability.card !== card2 || stability.region !== readyRegion || stability.control !== control || stability.signature !== signature) {
          stability?.observer.disconnect();
          const observer = new MutationObserver(() => {
            if (stability) stability.quietSince = Date.now();
          });
          stability = { card: card2, region: readyRegion, control, signature, quietSince: Date.now(), observer };
          observer.observe(readyRegion, { subtree: true, childList: true, characterData: true, attributes: true });
        }
        if (stability.observer.takeRecords().length || readDialogState(readyRegion).busy || control?.matches(':disabled,[aria-disabled="true"]')) stability.quietSince = Date.now();
        const quietMs = Date.now() - stability.quietSince;
        activityDiagnostic = { stage: "readiness", dispatches: 0, quietMs, region: readyRegion, control, url: location.href };
        return quietMs >= 2500 ? { card: card2, options: options2 } : void 0;
      }).finally(() => stability?.observer.disconnect());
      const card = ready.card;
      let options = ready.options;
      if (options.length !== 1) {
        if ([...document.querySelectorAll('[role="menu"]')].some(visible2)) throw new Error("EXISTING_OVERLAY: Close the existing menu before opening post activity.");
        const more = interactive(card).filter((el) => /^(?:More|More options|更多|更多選項)$/i.test(label(el)) && /^(?:menu|true)$/.test(el.getAttribute("aria-haspopup") || ""));
        if (more.length !== 1) throw new Error("UI_CHANGED: A unique exact-post More menu is required to open activity.");
        activityDiagnostic.stage = "menu";
        activityDiagnostic.dispatches++;
        more[0].click();
        options = await waitActivity("menu", () => {
          const menus = [...document.querySelectorAll('[role="menu"],[role="dialog"]')].filter(visible2);
          const found = menus.flatMap((menu) => interactive(menu).filter((el) => /^(?:View activity|Post activity|查看動態|貼文動態)$/i.test(label(el))));
          return found.length === 1 ? found : void 0;
        });
      }
      if (currentPostTarget()?.url !== target.url || !options[0].isConnected || !visible2(options[0])) throw new Error("CONTEXT_CHANGED: The post or activity control changed before activity opened.");
      clearActivityBinding();
      activityDiagnostic.stage = "overview";
      activityDiagnostic.control = options[0];
      activityDiagnostic.dispatches++;
      options[0].click();
      dialog = await waitActivity("overview", () => {
        if (currentPostTarget()?.url !== target.url) throw new Error("CONTEXT_CHANGED: The post changed while activity opened.");
        const active2 = visibleDialog();
        const state2 = postActivity(active2);
        if (!active2 || !state2 || state2.busy) return void 0;
        if (state2.targetUrl === target.url) {
          bindActivitySession(target, active2);
          return active2;
        }
        if (state2.selectedTab === null && !active2.querySelector('a[href*="/post/"]')) {
          bindActivitySession(target, active2);
          return active2;
        }
        throw new Error("TARGET_UNVERIFIED: The opened activity view does not identify the requested post.");
      });
    }
    const state = postActivity(dialog);
    if (!state || state.targetUrl !== target.url) throw new Error("TARGET_UNVERIFIED: The activity dialog does not identify the requested post.");
    bindActivitySession(target, dialog);
    if (activityTab && state.selectedTab !== activityTab) {
      if (state.selectedTab) throw new Error("UI_CHANGED: Return to the activity overview before selecting another activity list.");
      const pattern = activityTab === "likes" ? /^(?:按讚內容|Likes)[\d,.萬万KMB]*$/i : /^(?:轉發|Reposts?)[\d,.萬万KMB]*$/i;
      const choices = interactive(dialog).filter((el) => el.matches('button,[role="button"]') && pattern.test(el.innerText.replace(/\s+/g, "")));
      if (choices.length !== 1) throw new Error("UI_CHANGED: A unique activity-list selector was not observed.");
      activityDiagnostic.stage = activityTab;
      activityDiagnostic.dispatches++;
      choices[0].click();
      await waitActivity(activityTab, () => {
        const active2 = postActivity(visibleDialog());
        if (currentPostTarget()?.url !== target.url) throw new Error("CONTEXT_CHANGED: The post changed while activity loaded.");
        return active2?.targetUrl === target.url && active2.selectedTab === activityTab && !active2.busy ? active2 : void 0;
      });
    }
    activityDiagnostic.stage = "complete";
    return { opened: "likers", activityTab: activityTab ?? null, targetUrl: target.url, verified: false };
  }
  function domPosts(observedAt) {
    const results = [];
    const reaction = /^(Like|Unlike|讚|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i;
    const links2 = [...document.querySelectorAll('a[href*="/post/"]')].filter((link) => visible2(link) && link.protocol === "https:" && ["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(link.hostname) && !link.username && !link.password && !link.port).flatMap((link) => {
      const match = link.pathname.match(/^\/@([\w.]+)\/post\/([\w-]+)\/?$/);
      return match ? [{ link, username: match[1], code: match[2] }] : [];
    });
    const byCode = /* @__PURE__ */ new Map();
    for (const entry of links2) byCode.set(entry.code, [...byCode.get(entry.code) ?? [], entry]);
    for (const [code, entries] of byCode) {
      const candidates = /* @__PURE__ */ new Set();
      for (const { link } of entries) {
        let candidate = link;
        for (let depth = 0; candidate && depth < 14; depth++, candidate = candidate.parentElement) {
          if (candidate === document.body || candidate.matches('main,[role="main"]')) break;
          const controls2 = interactive(candidate).filter((el) => el.matches('button,[role="button"]') && reaction.test(label(el)));
          if (controls2.length > 1) break;
          if (controls2.length === 1 && !links2.some((other) => other.code !== code && candidate.contains(other.link))) {
            candidates.add(candidate);
            break;
          }
        }
      }
      const isolated = [...candidates].filter((candidate) => ![...candidates].some((other) => other !== candidate && candidate.contains(other)));
      if (isolated.length !== 1) continue;
      const card = isolated[0];
      const identity = entries.find((entry) => card.contains(entry.link));
      const buttons = interactive(card);
      const metric = (re) => {
        const matches = buttons.filter((e) => e.matches('button,[role="button"]') && re.test(label(e)));
        const b = matches.length === 1 ? matches[0] : null;
        return b ? parseCount(b.innerText.replace(/\s+/g, " ")) ?? parseCount(label(b)) : null;
      };
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      const textParts = [];
      let node;
      while (node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest('a,button,[role="button"],time,svg,script,style') || !visible2(parent)) continue;
        const value = node.textContent?.trim();
        if (value) textParts.push(value);
      }
      const time = card.querySelector("time[datetime]")?.getAttribute("datetime");
      const normalizedTime = time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
      const like = buttons.find((e) => e.matches('button,[role="button"]') && reaction.test(label(e)));
      results.push({ id: `url:${code}`, code, url: `https://www.threads.com/@${identity.username}/post/${code}`, author: { username: identity.username }, text: textParts.join("\n"), createdAt: normalizedTime, likes: metric(reaction), replies: metric(/^(Reply|Replied|回覆|已回覆)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i), reposts: metric(/^(Repost|轉發)(?:\s*\d[\d.,]*(?:\s*[萬万億亿KMB])?)?$/i), quotes: null, views: null, isReply: null, parentId: null, rootId: null, likedByViewer: like ? /^(Unlike|收回讚)/i.test(label(like)) : null, media: [], observedAt, source: "browser-dom" });
    }
    return results;
  }
  function dialogUsers(dialog) {
    if (!dialog) return [];
    const map = /* @__PURE__ */ new Map();
    for (const link of dialog.querySelectorAll('a[href^="/@"]')) {
      const username = link.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];
      if (!username || map.has(username) || !visible2(link) || link.closest('[aria-hidden="true"]')) continue;
      map.set(username, { username, bio: null, followers: null, following: null, private: null, url: `https://www.threads.com/@${username}`, links: [] });
    }
    return [...map.values()];
  }
  var notificationBadgePaths = { "like": "M5 8.33956C5 6.84296 6.07645 5.75 7.48174 5.75C8.08884 5.75 8.61175 5.95938 9.00094 6.30299C9.3914 5.95863 9.91188 5.75 10.5183 5.75C11.9276 5.75 13 6.84345 13 8.33956C13 9.20812 12.6297 10.037 12.0266 10.7947C11.4237 11.5521 10.5712 12.2609 9.5565 12.9023L9.55379 12.904C9.48997 12.9437 9.41108 12.9882 9.32747 13.0242C9.25284 13.0563 9.1332 13.1001 9 13.1001C8.86687 13.1001 8.74693 13.0551 8.67518 13.0242C8.59318 12.9889 8.51482 12.9453 8.45151 12.9072L8.44748 12.9048L8.4435 12.9023C7.42882 12.2609 6.57626 11.5521 5.97338 10.7947C5.37032 10.037 5 9.20812 5 8.33956Z", "follow": "M5.81283 13C5.55932 13 5.35968 12.9466 5.2139 12.8398C5.0713 12.736 5 12.5921 5 12.4082C5 12.1235 5.0919 11.8224 5.2757 11.505C5.4595 11.1876 5.72569 10.891 6.07427 10.6151C6.42286 10.3363 6.84274 10.1109 7.33393 9.93882C7.82828 9.76381 8.38285 9.67631 8.99762 9.67631C9.61557 9.67631 10.1701 9.76381 10.6613 9.93882C11.1557 10.1109 11.5756 10.3363 11.921 10.6151C12.2696 10.891 12.5357 11.1876 12.7195 11.505C12.9065 11.8224 13 12.1235 13 12.4082C13 12.5921 12.9271 12.736 12.7813 12.8398C12.6387 12.9466 12.4407 13 12.1872 13H5.81283ZM9.00238 8.87987C8.6633 8.87987 8.34957 8.79384 8.0612 8.6218C7.77283 8.44679 7.53991 8.21246 7.36245 7.9188C7.18816 7.62217 7.10101 7.28995 7.10101 6.92214C7.10101 6.56025 7.18816 6.23396 7.36245 5.94327C7.53991 5.65258 7.77283 5.42269 8.0612 5.25362C8.34957 5.08454 8.6633 5 9.00238 5C9.34145 5 9.65518 5.08306 9.94355 5.24917C10.2319 5.41528 10.4633 5.64368 10.6376 5.93437C10.815 6.2221 10.9037 6.54839 10.9037 6.91324C10.9037 7.28402 10.815 7.61772 10.6376 7.91435C10.4633 8.21098 10.2319 8.44679 9.94355 8.6218C9.65518 8.79384 9.34145 8.87987 9.00238 8.87987Z", "reply": "M8.62523 12.5C8.5337 12.5 8.44836 12.4796 8.3692 12.4389C8.29004 12.4008 8.20594 12.3384 8.11688 12.2519L5.18924 9.4084C5.1175 9.33969 5.06803 9.26972 5.04082 9.19847C5.01361 9.12723 5 9.06107 5 9C5 8.93639 5.01361 8.86896 5.04082 8.79771C5.06803 8.72646 5.1175 8.65649 5.18924 8.58779L8.11688 5.77099C8.21583 5.6743 8.30117 5.6056 8.37291 5.56489C8.44465 5.52163 8.52628 5.5 8.61781 5.5C8.74892 5.5 8.85529 5.5458 8.93692 5.6374C9.01855 5.72901 9.05937 5.83842 9.05937 5.96565V7.4084H9.16698C9.83488 7.4084 10.41 7.51399 10.8924 7.72519C11.3772 7.93639 11.7743 8.24173 12.0835 8.64122C12.3952 9.04071 12.6252 9.5229 12.7737 10.0878C12.9246 10.6501 13 11.2837 13 11.9885C13 12.1539 12.9604 12.2799 12.8813 12.3664C12.8046 12.4555 12.7168 12.5 12.6178 12.5C12.5387 12.5 12.4583 12.4835 12.3766 12.4504C12.2975 12.4173 12.2257 12.3397 12.1614 12.2176C11.9462 11.8003 11.6976 11.4746 11.4156 11.2405C11.1336 11.0038 10.8083 10.8372 10.4397 10.7405C10.0711 10.6438 9.64688 10.5954 9.16698 10.5954H9.05937V12.0534C9.05937 12.1832 9.01855 12.2901 8.93692 12.374C8.85529 12.458 8.75139 12.5 8.62523 12.5Z" };
  function notificationBadge(row) {
    const icons = [...row.querySelectorAll("svg")].filter((icon) => icon.getAttribute("viewBox")?.trim() === "0 0 18 18" && rendered(icon) && !icon.closest('[aria-hidden="true"],[inert]') && icon.querySelectorAll("path").length === 1);
    if (!icons.length) return void 0;
    if (icons.length !== 1) return { kind: "unknown", signature: null };
    const path = icons[0].querySelector("path")?.getAttribute("d");
    const kind = Object.keys(notificationBadgePaths).find((kind2) => notificationBadgePaths[kind2] === path);
    return { kind: kind ?? "unknown", signature: kind ? "threads-18-" + kind + "-v1" : null };
  }
  function notificationRows() {
    if (!/^\/activity(?:\/|$)/.test(location.pathname)) return [];
    const rows = /* @__PURE__ */ new Set();
    for (const time of document.querySelectorAll("time")) {
      if (!rendered(time) || time.closest('nav,[role="navigation"],[aria-hidden="true"]')) continue;
      let candidate = time.parentElement;
      let selected = null;
      for (let depth = 0; candidate && depth < 12; depth++, candidate = candidate.parentElement) {
        if (candidate === document.body || candidate.matches('main,aside,[role="main"],[role="complementary"]') || candidate.querySelectorAll("time").length !== 1) break;
        if (candidate.querySelector('nav,aside,[role="navigation"],[role="complementary"]')) break;
        const profiles = [...candidate.querySelectorAll("a[href]")].filter((a) => /^\/@[\w.]+\/?$/.test(a.pathname) && visible2(a) && !a.closest('[aria-hidden="true"]'));
        if (profiles.some((link) => /^(Profile|個人檔案)$/i.test(label(link)))) break;
        const text2 = candidate.innerText?.trim() || "";
        const postLink = [...candidate.querySelectorAll("a[href]")].some((link) => /\/post\/[\w-]+/.test(link.pathname));
        const action = /(?:liked your|replied to you|mentioned you|reposted your|quoted your|following you|followed you|回覆了你|提及了你|提到了你|轉發了你|開始追蹤你|追蹤了你|已追蹤你|讚了你的)/i.test(text2);
        const badge = notificationBadge(candidate);
        if (profiles.length && text2.length < 4e3 && badge) {
          selected = candidate;
          break;
        }
        if (!selected && profiles.length && text2.length < 4e3 && (postLink || action)) selected = candidate;
      }
      if (selected && (notificationBadge(selected) || !interactive(selected).some((el) => /^(Like|Unlike|Reply|Replied|讚|收回讚|回覆|已回覆)(?:\s*\d|$)/i.test(label(el))))) rows.add(selected);
    }
    return [...rows].slice(0, 100).map((row) => {
      const links2 = [...row.querySelectorAll("a[href]")].filter((a) => visible2(a) && !a.closest('[aria-hidden="true"]'));
      const time = row.querySelector("time");
      let header = time?.parentElement ?? null;
      while (header && header !== row && !links2.some((link) => /^\/@[\w.]+\/?$/.test(link.pathname) && header.contains(link))) header = header.parentElement;
      const actorLinks = links2.filter((link) => header?.contains(link));
      const aggregate = header?.innerText.match(/和另外\s*([\d,]+)\s*人|and\s+([\d,]+)\s+others?/i);
      const additionalActorCount = aggregate ? Number((aggregate[1] ?? aggregate[2]).replaceAll(",", "")) : null;
      const actionText = [...row.querySelectorAll("span,div")].filter((el) => visible2(el) && !el.closest('a,button,[role="button"]')).map((el) => el.innerText.trim()).find((text2) => /^(?:已追蹤你|開始追蹤你|追蹤了你|started following you|followed you)$/i.test(text2)) ?? null;
      return { text: row.innerText.slice(0, 4e3), actorLinks: actorLinks.flatMap((a) => {
        const username = a.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];
        return username ? [{ username, url: a.href }] : [];
      }), postLinks: [...new Set(links2.filter((a) => /\/post\/[\w-]+/.test(a.pathname)).map((a) => a.href))], timeLabel: time?.textContent?.trim() || null, timestamp: time?.getAttribute("datetime") || null, badge: notificationBadge(row), actionText, additionalActorCount };
    });
  }
  function searchProfiles() {
    if (location.pathname !== "/search" || new URL(location.href).searchParams.get("filter") !== "profiles") return [];
    const found = /* @__PURE__ */ new Map();
    const scope = document.querySelector('main,[role="main"]') ?? document;
    for (const link of scope.querySelectorAll("a[href]")) {
      const name2 = link.pathname.match(/^\/@([\w.]+)\/?$/)?.[1];
      if (!name2 || link.protocol !== "https:" || link.port && link.port !== "443" || !["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(link.hostname) || link.username || link.password || !visible2(link) || link.closest('nav,aside,[role="navigation"],[role="complementary"],[aria-hidden="true"]') || /^(Profile|個人檔案)$/i.test(label(link))) continue;
      found.set(name2.toLowerCase(), { username: name2, url: link.href, bio: null, followers: null, following: null, private: null, links: [] });
    }
    return [...found.values()];
  }
  function readPage() {
    guard2();
    const observedAt = (/* @__PURE__ */ new Date()).toISOString();
    const payloads = [];
    let size = 0;
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const value = script.textContent || "";
      size += value.length;
      if (size > 12e6) break;
      payloads.push(...parseWire(value));
    }
    const rootCode = location.pathname.match(/\/post\/([\w-]+)/)?.[1];
    const parsed = parsePayloads(payloads, { rootCode, observedAt });
    const dom = domPosts(observedAt);
    const navigation = performance.getEntriesByType("navigation")[0];
    const documentRoute = navigation ? routeKey(navigation.name) : null;
    const documentMatches = documentRoute !== null && documentRoute === routeKey(location.href) && !observedRouteChange;
    const merged = documentMatches ? dedupePosts([...dom, ...parsed.posts]) : dom.map((post) => {
      const json = parsed.posts.find((candidate) => candidate.code === post.code && candidate.author.username === post.author.username);
      return json ? { ...post, id: json.id, author: { ...post.author, ...json.author.id ? { id: json.author.id } : {} } } : post;
    });
    for (const p of merged) {
      const d = dom.find((x) => x.code === p.code);
      if (d) {
        for (const key of ["likes", "replies", "reposts", "likedByViewer"]) if (d[key] !== null && d[key] !== void 0) p[key] = d[key];
      }
    }
    const pageText = document.body.innerText.slice(0, 24e3);
    const warnings = [...parsed.warnings];
    if (!documentMatches) warnings.push("SSR_SCOPE_UNCERTAIN: The current route does not match the fetched document, a route change was observed, or document navigation provenance is unavailable. Only visible DOM posts are returned; old JSON supplies matching canonical IDs only. Profiles and reply classification from that JSON are omitted.");
    else if (attachedAfterDocumentStarted) warnings.push("SSR_DOCUMENT_SNAPSHOT: JSON records reflect the fetched document, not a new network fetch. Navigation away and back before runtime attachment cannot be ruled out.");
    if (/\/login|\/challenge/.test(location.pathname)) warnings.push("LOGIN_REQUIRED: Complete login or account challenge manually.");
    if (size > 12e6) warnings.push("Page JSON exceeded the capture budget; result is partial.");
    if (dom.some((p) => !parsed.posts.some((x) => x.code === p.code))) warnings.push("Some posts came from visible DOM; unavailable IDs, timestamps or relationships remain unknown.");
    const replies = documentMatches ? parsed.replies.map((reply) => {
      const post = merged.find((candidate) => candidate.code === reply.code);
      if (!post) return reply;
      post.rootId = reply.rootId ?? post.rootId;
      post.parentId = reply.parentId ?? post.parentId;
      post.isReply = reply.isReply ?? true;
      return post;
    }) : [];
    const dialog = visibleDialog();
    const isProfileSearch = location.pathname === "/search" && new URL(location.href).searchParams.get("filter") === "profiles";
    const profiles = new Map((documentMatches && !isProfileSearch ? parsed.profiles : []).map((profile) => [profile.username.toLowerCase(), profile]));
    for (const profile of searchProfiles()) if (!profiles.has(profile.username.toLowerCase())) profiles.set(profile.username.toLowerCase(), profile);
    return { runtimeVersion, runtimeRevision, remoteMediaVersion: 1, url: location.href, title: document.title, posts: merged, profiles: [...profiles.values()], replies, dialogUsers: dialogUsers(dialog), dialogState: readDialogState(dialog), composerState: readComposerState(), postActivity: postActivity(dialog), notificationRows: notificationRows(), visibilityState: document.visibilityState, viewer: viewer(), text: pageText, warnings, observedAt, runtimeDiagnostics: runtimeDiagnostics(dialog) };
  }
  return __toCommonJS(page_runtime_exports);
})();
