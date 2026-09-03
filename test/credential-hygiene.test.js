import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('tracked configuration은 고정된 database password를 포함하지 않는다', () => {
  const paths = [
    '.env.example',
    '.github/workflows/ci.yml',
    '.github/workflows/test.yml',
    'compose.yaml',
    'README.md',
  ];

  for (const path of paths) {
    assert.doesNotMatch(read(path), /course-(?:ci|local)-only/, path);
  }
});

test('CI와 local PostgreSQL은 실행 시 주입한 password만 사용한다', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/test.yml']) {
    const workflow = read(path);
    assert.match(workflow, /POSTGRES_PASSWORD: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/, path);
    assert.match(workflow, /DATABASE_TEST_URL: postgresql:\/\/commerce:\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}@127\.0\.0\.1:5432\/commerce/, path);
  }

  assert.match(read('compose.yaml'), /POSTGRES_PASSWORD: ["']?\$\{DB_PASSWORD:\?/);
  assert.match(read('.env.example'), /^DB_PASSWORD=$/m);
});
