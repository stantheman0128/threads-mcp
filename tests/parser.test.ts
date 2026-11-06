import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePost, parsePayloads, parseWire, parseCount, dedupePosts } from '../src/parser.js';

const post = (code: string, extra = {}) => ({ pk: code === 'ROOT' ? '100' : code, code, user: { pk: '7', username: 'alice' }, caption: { text: code }, ...extra });

test('counts retain unknown and hidden values and preserve large string IDs', () => {
  const result = normalizePost(post('ROOT', { pk: '9876543210987654321', like_count: 0, reply_count: 4, taken_at: 1700000000 }));
  assert.equal(result?.id, '9876543210987654321');
  assert.equal(result?.likes, 0);
  assert.equal(result?.views, null);
  assert.equal(result?.replies, 4);
  assert.equal(result?.createdAt, '2023-11-14T22:13:20.000Z');
  const hidden = normalizePost(post('HIDDEN', { like_count: 99, view_count: 100, like_and_view_counts_disabled: true }));
  assert.equal(hidden?.likes, null);
  assert.equal(hidden?.views, null);
  assert.equal(normalizePost(post('BAD', { pk: 9876543210987654321 })), null);
});

test('replies are linked by root IDs or anchored conversation context, not arbitrary replies keys', () => {
  const result = parsePayloads([
    { containing_thread: { thread_items: [{ post: post('ROOT') }] }, reply_threads: [
      { post: post('DIRECT'), replies: [{ post: post('NESTED') }] },
      { post: post('CONTRADICTED', { root_post: { id: '999' } }) },
    ] },
    { post: post('OTHER'), replies: [{ post: post('UNRELATED') }] },
    { replies: [{ post: post('UNANCHORED') }] },
    { post: post('EXPLICIT', { root_post: { id: '100_7' } }) },
  ], { rootCode: 'ROOT' });
  assert.deepEqual(result.replies.map(p => p.code).sort(), ['DIRECT', 'EXPLICIT', 'NESTED']);
  assert.ok(result.posts.some(p => p.code === 'UNRELATED'));
  assert.ok(result.posts.some(p => p.code === 'UNANCHORED'));
});

test('quoted and recommended originals are excluded and duplicates enrich missing fields', () => {
  const payload = { post: post('ROOT'), quoted_post: post('QUOTE'), related_posts: [post('RELATED')] };
  const result = parsePayloads([payload, { post: post('ROOT', { like_count: 8 }) }]);
  assert.deepEqual(result.posts.map(p => p.code), ['ROOT']);
  assert.equal(result.posts[0]?.likes, 8);
  const older = normalizePost(post('ROOT', { like_count: 8 }))!;
  assert.equal(dedupePosts([older, normalizePost(post('ROOT'))!])[0]?.likes, 8);
});

test('Threads media root anchors its nested direct_replies connection',()=>{
  const result=parsePayloads([{data:{media:post('ROOT',{text_post_app_info:{direct_replies:{edges:[{node:{posts:{edges:[{node:post('CHILD',{text_post_app_info:{is_reply:true}})}]}}}]}}})}}],{rootCode:'ROOT'});
  assert.deepEqual(result.replies.map(p=>p.code),['CHILD']);
  assert.equal(result.replies[0]?.rootId,'100');
});

test('wire framing and displayed count abbreviations parse without assuming missing counts are zero', () => {
  assert.deepEqual(parseWire('for (;;);{"data":1}\n{"data":2}'), [{data:1},{data:2}]);
  assert.equal(parseCount('1.2 萬'), 12000);
  assert.equal(parseCount('1,230'), 1230);
  assert.equal(parseCount('2.5K'), 2500);
  assert.equal(parseCount('Like'), null);
});

test('separate code-less media reply fragments anchor by canonical root ID only',()=>{
  const fragment=(rootId:string,code:string)=>({data:{media:{id:rootId,text_post_app_info:{id:'app-info',direct_replies:{edges:[{node:{posts:{edges:[{node:post(code,{text_post_app_info:{is_reply:true}})}]}}}]}}}}});
  for(const payloads of [[{data:{media:post('ROOT')}},fragment('100_7','CHILD'),fragment('999_7','OTHER')],
    [fragment('100_7','CHILD'),fragment('999_7','OTHER'),{data:{media:post('ROOT')}}]]){
    const result=parsePayloads(payloads,{rootCode:'ROOT'});
    assert.deepEqual(result.replies.map(p=>p.code),['CHILD']);
    assert.equal(result.replies[0]?.rootId,'100');
    assert.ok(result.posts.some(p=>p.code==='OTHER'));
  }
});
