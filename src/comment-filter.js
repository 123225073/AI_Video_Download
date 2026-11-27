function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().trim();
}

export function filterComments(comments, users, query) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return {comments, users};

  const byUser = new Map();
  const matches = comments.filter(row => {
    const fields = [row.name, row.userId, row.text, row.region, row.published].map(normalize);
    if (!terms.every(term => fields.some(field => field.includes(term)))) return false;
    if (row.userId) {
      if (!byUser.has(row.userId)) byUser.set(row.userId, []);
      byUser.get(row.userId).push(row);
    }
    return true;
  });
  return {
    comments: matches,
    users: users.filter(user => byUser.has(user.id)).map(user => ({...user, comments: byUser.get(user.id)}))
  };
}
