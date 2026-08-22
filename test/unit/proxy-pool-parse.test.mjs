import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSocks5Line, parseSocks5Fields } from '../../src/lib/vm/proxy-pool.mjs'

test('recognizes host:port:user:pass vendor lines as socks5', () => {
  const parsed = parseSocks5Line('154.9.177.229:5509:howwaqev:lgg15vfswgy8')
  assert.equal(parsed.scheme, 'socks5')
  assert.equal(parsed.host, '154.9.177.229')
  assert.equal(parsed.port, 5509)
  assert.equal(parsed.username, 'howwaqev')
  assert.equal(parsed.password, 'lgg15vfswgy8')
})

test('recognizes user:pass@host:port and socks5 URLs', () => {
  const at = parseSocks5Line('howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(at.host, '154.9.177.229')
  assert.equal(at.port, 5509)
  assert.equal(at.username, 'howwaqev')
  const url = parseSocks5Line('socks5h://howwaqev:lgg15vfswgy8@154.9.177.229:5509')
  assert.equal(url.host, '154.9.177.229')
  assert.equal(url.username, 'howwaqev')
})

test('recognizes user:pass:host:port and structured fields', () => {
  const flipped = parseSocks5Line('howwaqev:lgg15vfswgy8:154.9.177.229:5509')
  assert.equal(flipped.host, '154.9.177.229')
  assert.equal(flipped.port, 5509)
  assert.equal(flipped.username, 'howwaqev')
  const fields = parseSocks5Fields({
    host: '154.9.177.229',
    port: '5509',
    username: 'howwaqev',
    password: 'secret',
  })
  assert.equal(fields.scheme, 'socks5')
  assert.equal(fields.port, 5509)
  assert.equal(fields.username, 'howwaqev')
})

test('rejects incomplete or non-proxy lines', () => {
  assert.equal(parseSocks5Line(''), null)
  assert.equal(parseSocks5Line('# comment'), null)
  assert.equal(parseSocks5Line('154.9.177.229'), null)
  assert.equal(parseSocks5Fields({ host: '154.9.177.229' }), null)
})
