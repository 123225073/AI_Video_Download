export async function enqueueInChunks(perform, items, options, progress = () => {}) {
  const result = { added: [], skipped: [], submitted: 0, error: null };
  for (let offset = 0; offset < items.length; offset += 200) {
    try {
      const r = await perform('enqueue', items.slice(offset, offset + 200), options);
      result.added.push(...r.added); result.skipped.push(...r.skipped);
      result.submitted += Math.min(200, items.length - offset); progress(result.submitted);
      await new Promise(resolve => setTimeout(resolve, 0));
    } catch (error) { result.error = error.message; break; }
  }
  return result;
}
export const concurrencyLabel = value => value === 'auto' ? '自动调度' : `上限 ${value} 个`;
