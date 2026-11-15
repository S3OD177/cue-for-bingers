// The OpenAPI contract leaves the /library/check response shape unspecified
// ("each item is unknown, not_in_library, or the user's status"), so accept the
// plausible shapes and always return { [ref]: { status, ... } } for every requested ref.

function pick(v) {
  if (typeof v === "string") return { status: v };
  if (v && typeof v === "object") {
    const status = v.status ?? v.my_status ?? v.state ?? "unknown";
    return { ...v, status: typeof status === "string" ? status : "unknown" };
  }
  return { status: "unknown" };
}

function keyOf(item) {
  if (!item || typeof item !== "object") return null;
  for (const k of ["ref", "reference", "query", "input", "requested"]) {
    if (typeof item[k] === "string") return item[k];
  }
  return typeof item.title === "string" ? item.title : null;
}

export function normalizeCheck(data, refs) {
  const out = {};
  const container = data?.items ?? data?.results ?? data?.titles ?? data;

  if (Array.isArray(container)) {
    container.forEach((item, i) => {
      const k = keyOf(item);
      const ref = k && refs.includes(k) ? k : refs[i];
      if (ref) out[ref] = pick(item);
    });
  } else if (container && typeof container === "object") {
    for (const ref of refs) if (ref in container) out[ref] = pick(container[ref]);
  }

  for (const ref of refs) if (!out[ref]) out[ref] = { status: "unknown" };
  return out;
}
