import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fingerprints} from './table-fingerprints.mjs';

test('cursor pages retain exact canonical newline hash and close empty tables',async()=>{
  const pages=[[{row:'{"x":1}'},{row:'{"x":2}'}],[],[]];let closed=0;
  const client={async query(query){
    if(query.includes('FROM pg_tables'))return {rows:[{tablename:'jobs'},{tablename:'workspace_documents'}]};
    if(query.startsWith('FETCH FORWARD 256'))return {rows:pages.shift()};
    if(query.startsWith('CLOSE '))closed++;
    return {rows:[]};
  }};
  const result=await fingerprints(client);
  assert.deepEqual(result,[{table:'jobs',rows:2,sha256:createHash('sha256').update('{"x":1}\n{"x":2}\n').digest('hex')},
    {table:'workspace_documents',rows:0,sha256:createHash('sha256').digest('hex')}]);
  assert.equal(closed,2);assert.equal(pages.length,0);
});
test('cursor is closed after a read failure',async()=>{
  let closed=false;
  const client={async query(query){
    if(query.includes('FROM pg_tables'))return {rows:[{tablename:'jobs'}]};
    if(query.startsWith('FETCH'))throw Error('Read failed');
    if(query.startsWith('CLOSE'))closed=true;
    return {rows:[]};
  }};
  await assert.rejects(fingerprints(client),/Read failed/);assert.equal(closed,true);
});
test('unexpected identifiers are rejected before cursor SQL',async()=>{
  const calls=[];
  const client={async query(query){calls.push(query);return {rows:[{tablename:'jobs"; DROP SCHEMA public;'}]}}};
  await assert.rejects(fingerprints(client),/Unreviewed/);assert.equal(calls.length,1);
});
