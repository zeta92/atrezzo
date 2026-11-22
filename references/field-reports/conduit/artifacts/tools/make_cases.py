"""Builds one scenario variant + one flow per injected cause, from conduit-session.yaml.

Usage: python3 -I make_cases.py <project-dir>
Each variant changes exactly one thing; the flow keeps the assertions of the intended state.
"""
import sys, os

root = sys.argv[1]
scen_dir = os.path.join(root, 'atrezzo/scenarios')
flow_dir = os.path.join(root, 'atrezzo/flows/inject')
os.makedirs(flow_dir, exist_ok=True)
base = open(os.path.join(scen_dir, 'conduit-session.yaml')).read()
SLUG = '21b6be78-8754-4566-820d-a428f1ece189'
FEED_PAG = '''    pagination: { param_limit: limit, param_offset: offset }
    sort: -createdAt
    shape: envelope
    envelope: { items: articles, total: articlesCount }
    detail: false
  - path: /api/articles
'''

def once(s, old, new):
    assert s.count(old) >= 1, old
    return s.replace(old, new, 1)

CASES = {
  # cause: the client filters by ?tag=, the scenario cannot express "tagList contains"
  'tag-filter': (lambda s: s, 'undeclared-filter', '''steps:
  - screen: tag
    visit: /
    wait_for: ".sidebar .tag-pill"
    click: ".sidebar .tag-pill >> nth=2"
    requests:
      byTag: GET /api/articles?tag=welcome&limit=10&offset=0
    expect:
      - selector: ".article-preview"
        count: 5
        label: articles tagged welcome
        data: { request: byTag, pick: articles }
'''),
  # cause: world: alice follows nobody, the feed is empty
  'feed-world': (lambda s: once(s, 'following: [false, true, true, false]', 'following: [false, false, false, false]'), 'world-mismatch', '''steps:
  - screen: feed
    visit: /
    wait_for: ".article-preview"
    requests:
      feed: GET /api/articles/feed?limit=10&offset=0
    expect:
      - selector: ".article-preview .preview-link"
        count: 10
        label: feed rows
        data: { request: feed, pick: articles }
'''),
  # cause: the scenario declares an error on /api/tags
  'tags-error': (lambda s: once(s, '    pluck: name\n    pick: tags\n', '    pluck: name\n    pick: tags\n    error: { status: 500 }\n'), 'declared-error', '''steps:
  - screen: home
    visit: /
    wait_for: ".article-preview .preview-link"
    requests:
      tags: GET /api/tags
    expect:
      - selector: ".sidebar .tag-pill"
        count: 6
        label: popular tags
        data: { request: tags, pick: tags }
'''),
  # cause: the endpoint caps limit at 5, the client asks for 10
  'feed-max-limit': (lambda s: once(s, FEED_PAG, FEED_PAG.replace('param_offset: offset }', 'param_offset: offset, max_limit: 5 }', 1)), 'pagination-mismatch', '''steps:
  - screen: feed
    visit: /
    wait_for: ".article-preview .preview-link"
    requests:
      feed: GET /api/articles/feed?limit=10&offset=0
    expect:
      - selector: ".article-preview"
        count: 10
        label: feed rows
        data: { request: feed, pick: articles }
'''),
  # cause: 3 articles without author; the preview reads article.author.username
  'null-author': (lambda s: once(s, '      tagList: [[dragons, training], [welcome], [react, redux]]\n', '      tagList: [[dragons, training], [welcome], [react, redux]]\n    nulls: { author_id: 3 }\n'), 'null-field', '''steps:
  - screen: home
    visit: /
    wait_for: ".article-preview"
    requests:
      articles: GET /api/articles?limit=10&offset=0
    expect:
      - selector: ".article-preview .preview-link"
        count: 10
        label: global feed rows
        data: { request: articles, pick: articles }
'''),
  # cause: world: no tags
  'tags-empty': (lambda s: once(s, '  tags:\n    total: 6\n', '  tags:\n    total: 0\n'), 'world-mismatch', '''steps:
  - screen: home
    visit: /
    wait_for: ".article-preview .preview-link"
    requests:
      tags: GET /api/tags
    expect:
      - selector: ".sidebar .tag-pill"
        count: 6
        label: popular tags
        data: { request: tags, pick: tags }
'''),
  # cause: the feed endpoint sorts oldest first; the favourites of the newest page fall outside it
  'feed-sort': (lambda s: once(s, FEED_PAG, FEED_PAG.replace('sort: -createdAt', 'sort: createdAt', 1)), 'pagination-mismatch', '''steps:
  - screen: feed
    visit: /
    wait_for: ".article-preview .preview-link"
    requests:
      feed: GET /api/articles/feed?limit=10&offset=0
    expect:
      - selector: ".article-preview button.btn-primary"
        count: 4
        label: favourited among the 10 newest
        data: { request: feed, pick: articles, where: { favorited: true } }
'''),
  # cause: page-style pagination declared; the client sends offset, which is ignored
  'feed-page-style': (lambda s: once(s, FEED_PAG, FEED_PAG.replace('{ param_limit: limit, param_offset: offset }', '{ param_page: page, param_limit: limit, default_limit: 10 }', 1)), None, '''steps:
  - screen: feed-page-2
    visit: /
    wait_for: ".pagination .page-item"
    click: ".pagination .page-item >> nth=1"
    requests:
      feed2: GET /api/articles/feed?limit=10&offset=10
    expect:
      - selector: ".article-preview"
        count: 6
        label: second feed page (16 - 10)
        data: { request: feed2, pick: articles }
'''),
  # cause: the comments envelope key is wrong (data instead of comments)
  'comments-envelope': (lambda s: once(s, 'envelope: { items: comments }', 'envelope: { items: data }'), None, f'''steps:
  - screen: article
    visit: /article/{SLUG}
    wait_for: ".article-page h1"
    requests:
      comments: GET /api/articles/{SLUG}/comments
    expect:
      - selector: ".card .card-text"
        count: 5
        label: comments
        data: {{ request: comments, pick: comments }}
'''),
  # cause: every article shares one slug; the list is keyed by slug
  'duplicate-slug': (lambda s: once(s, '      slug: uuid\n', '      slug: [same-slug]\n'), None, '''steps:
  - screen: home
    visit: /
    wait_for: ".article-preview .preview-link"
    requests:
      feed: GET /api/articles/feed?limit=10&offset=0
    expect:
      - selector: ".article-preview"
        count: 10
        label: feed rows
        data: { request: feed, pick: articles }
'''),
  # cause: the favourite write echoes the bare row; the reducer reads payload.article
  'favorite-echo': (lambda s: once(s, '''    expect: { status: 200, body: { article: { slug: 21b6be78-8754-4566-820d-a428f1ece189, favorited: true, favoritesCount: 868 } } }''', '''    expect: { status: 200, echo: true }'''), 'page-error', '''steps:
  - screen: feed
    visit: /
    wait_for: ".article-preview .preview-link"
    click: ".article-preview button.btn-outline-primary"
    expect:
      - selector: ".article-preview button.btn-primary"
        count: 5
        label: favourited after one click
'''),
}

manifest = []
for cid, (patch, cause, steps) in CASES.items():
    name = f'f5-{cid}'
    s = patch(base).replace('name: conduit-session', f'name: {name}', 1)
    s = f'# F5 injected cause: {cid} (expected diagnosis: {cause})\n' + s
    open(os.path.join(scen_dir, f'{name}.yaml'), 'w').write(s)
    flow = f'''# F5 injected cause: {cid}. Assertions describe the intended state.
scenario: ../../scenarios/{name}.yaml
base_url: http://127.0.0.1:4010
storage:
  local: {{ jwt: "fake-token-for-the-mock" }}
''' + steps
    if cid in ('null-author',):
        flow = flow.replace('storage:\n  local: { jwt: "fake-token-for-the-mock" }\n', '')
    open(os.path.join(flow_dir, f'{name}.yaml'), 'w').write(flow)
    manifest.append(f'{cid}\t{cause}')
print('\n'.join(manifest))
