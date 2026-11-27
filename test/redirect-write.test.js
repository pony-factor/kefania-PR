import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMapping, validateRedirect, verifiedActor } from '../src/redirect-write.js';
const registries = {
  'redirects/main.toml': '[redirects]\n"old" = "https://example.com" # original\n',
  'redirects/law.toml': '[redirects."_"]\n"0" = "https://example.com"\n\n[redirects."+"]\n"0" = "https://example.com"\n',
  'redirects/priority.toml': '[HIGH]\n"priority" = "/reference"\n'
};
test('appends ordinary and legal entries without changing unrelated lines', () => {
  assert.equal(appendMapping(registries, {key:'New', href:'/ref/a.pdf', comment:'note'}).content,
    registries['redirects/main.toml'] + '"new" = "/ref/a.pdf" # note\n');
  const legal = appendMapping(registries, {key:'_1', href:'https://example.org'});
  assert.equal(legal.line, 3);
  assert.equal(legal.content, registries['redirects/law.toml'].replace('\n\n[redirects."+"]', '\n"1" = "https://example.org"\n\n[redirects."+"]'));
  assert.equal(appendMapping(registries, {key:'+1', href:'https://example.org'}).path, 'redirects/law.toml');
});
test('rejects duplicates, route collisions, arbitrary fields, unsafe URLs and comments', () => {
  for (const key of ['OLD','PRIORITY','+0','_0','search','a/b','%2f','..']) {
    assert.throws(() => appendMapping(registries, {key,href:'https://example.org'}));
  }
  assert.throws(() => appendMapping(registries,{key:'book',href:'/x'},['book']));
  for (const href of ['javascript:alert(1)','//evil.example','https://u:p@example.com','/%2fexample.com','https://example.com/%zz','https://example.com/<script>']) {
    assert.throws(() => validateRedirect({key:'new',href}));
  }
  assert.throws(() => validateRedirect({key:'new',href:'/x',comment:'line\nbreak'}));
  assert.throws(() => validateRedirect({key:'new',href:'/x',author:'forged'}));
});
test('uses current user permission and a verified nonprivate author email', async () => {
  const auth = { scopes:['kefania:redirect'], extra:{githubToken:'token',user:{id:1}} };
  const allowedRepositories = ['JFWooten4/JFWooten4'];
  const github = async (_token, endpoint) => endpoint === 'user' ? {id:1,login:'human',name:'Human'} :
    endpoint === 'user/emails' ? [{email:'private@example.com',verified:true,visibility:'private'},{email:'human@users.noreply.github.com',verified:true}] :
    {permissions:{push:true}};
  assert.equal((await verifiedActor({auth,allowedRepositories,oauth:{github}})).email,'human@users.noreply.github.com');
  await assert.rejects(verifiedActor({auth,allowedRepositories,oauth:{github:async (t,e) => e==='user/emails' ? [{email:'secret@example.com',verified:true,visibility:'private'}] : github(t,e)}}),/No verified/);
  await assert.rejects(verifiedActor({auth,allowedRepositories,oauth:{github:async (t,e) => e.startsWith('repos/') ? {permissions:{push:false}} : github(t,e)}}),/write access/);
});
