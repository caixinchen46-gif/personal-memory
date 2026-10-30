
import type { ChunkId, ScoredChunk, Chunk } from '../types/interfaces.js';

/**
 * 内存 BM25 索引。
 * 轻量实现：TF-IDF 加权 + BM25 公式。
 * 索引全量在内存中，适合 10 万级 chunk。
 */

interface BM25Doc {
  chunkId: ChunkId;
  chunk: Chunk;
  termFreq: Map<string, number>;
  docLen: number;
}

export class BM25Index {
  private docs: Map<ChunkId, BM25Doc> = new Map();
  private docCount = 0;
  private avgDocLen = 0;
  private idf: Map<string, number> = new Map();
  private k1 = 1.5;  // BM25 参数
  private b = 0.75;

  add(chunk: Chunk): void {
    const terms = this.tokenize(chunk.content);
    const termFreq = new Map<string, number>();
    for (const t of terms) {
      termFreq.set(t, (termFreq.get(t) || 0) + 1);
    }

    this.docs.set(chunk.id, {
      chunkId: chunk.id,
      chunk,
      termFreq,
      docLen: terms.length,
    });

    this.docCount++;
    this.avgDocLen = this.docCount > 0
      ? [...this.docs.values()].reduce((s, d) => s + d.docLen, 0) / this.docCount
      : 0;

    // 更新 IDF
    for (const term of new Set(terms)) {
      this.idf.set(term, (this.idf.get(term) || 0) + 1);
    }
  }

  remove(chunkId: ChunkId): void {
    const doc = this.docs.get(chunkId);
    if (!doc) return;
    for (const term of doc.termFreq.keys()) {
      const count = this.idf.get(term);
      if (count !== undefined && count > 1) this.idf.set(term, count - 1);
      else this.idf.delete(term);
    }
    this.docs.delete(chunkId);
    this.docCount--;
  }

  search(query: string, topK: number): ScoredChunk[] {
    const queryTerms = this.tokenize(query);
    const scores: { chunkId: ChunkId; score: number }[] = [];

    for (const [, doc] of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const df = this.idf.get(term) || 0;
        if (df === 0) continue;
        const tf = doc.termFreq.get(term) || 0;
        if (tf === 0) continue;
        const idfVal = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * doc.docLen / (this.avgDocLen || 1));
        score += idfVal * numerator / denominator;
      }
      if (score > 0) scores.push({ chunkId: doc.chunkId, score });
    }

    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK);
    const maxScore = top[0]?.score || 1;

    return top.map(s => ({
      chunk: this.docs.get(s.chunkId)!.chunk,
      score: s.score / maxScore,  // 归一化
      source: 'bm25' as const,
    }));
  }

  /** 按 id 取回完整 chunk（用于补齐向量检索结果的内容） */
  get(chunkId: ChunkId): Chunk | undefined {
    return this.docs.get(chunkId)?.chunk;
  }

  size(): number {
    return this.docCount;
  }

  private tokenize(text: string): string[] {
    // 中文：只取双字词（bigram）。单字噪声太大会导致「是/什/么」这类虚词误命中。
    // 英文/数字：整词小写。
    const tokens: string[] = [];

    const chineseRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of chineseRuns) {
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
      }
    }

    const enWords = text.match(/[a-zA-Z0-9]+/g) || [];
    for (const w of enWords) tokens.push(w.toLowerCase());

    return tokens;
  }
}
