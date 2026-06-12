import { readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';

export default function createBlogPlugin({ manifest, rootDir }) {
  const feature = {
    key: manifest.key || 'blog',
    label: manifest.name || 'Blog',
    href: '/blog',
    description: manifest.description || 'Markdown-based news and update feed with visual cards and article hero images.',
    defaultEnabled: true
  };

  return {
    key: feature.key,
    feature,
    publicDir: join(rootDir, 'public'),
    adminPage: {
      href: '/admin/blog',
      label: manifest.name || 'Blog'
    },
    seedInitialData(context) {
      const blogDir = getBlogDir(context);
      if (context.existsSync(blogDir) && readdirSync(blogDir).some((file) => file.endsWith('.md'))) return;
      if (!context.existsSync(blogDir)) context.mkdirSync(blogDir, { recursive: true });
      const posts = [
        {
          slug: 'welcome-to-atlas',
          meta: {
            title: 'Welcome to Atlas',
            description: 'A sample story that shows the blog layout, metadata and Markdown rendering.',
            excerpt: 'Use blog posts for internal updates, release context and team notes.',
            author: 'Atlas Team',
            publishedAt: '2026-06-12',
            roles: []
          },
          markdown: '# Welcome to Atlas\n\nThis example post demonstrates the blog plugin with Markdown content, excerpts and publishing metadata.\n\n## What to try\n\nOpen the admin studio, edit this post, and publish a note that fits your own workspace.'
        },
        {
          slug: 'policy-review-rhythm',
          meta: {
            title: 'Policy Review Rhythm',
            description: 'How teams can coordinate reviews with tasks, Q&A and changelogs.',
            excerpt: 'A short example article connecting multiple Atlas plugins.',
            author: 'Atlas Team',
            publishedAt: '2026-06-13',
            roles: []
          },
          markdown: '# Policy Review Rhythm\n\nUse documentation for the controlled policy text, tasks for ownership, Q&A for discussion, and changelogs for visible changes.\n'
        }
      ];
      for (const post of posts) {
        const filePath = normalize(join(blogDir, `${post.slug}.md`));
        if (!filePath.startsWith(blogDir) || context.existsSync(filePath)) continue;
        context.writeFileSync(filePath, context.ensureTrailingNewline(serializeBlogPost(context, post)), 'utf8');
      }
    },
    async handleRequest(context) {
      const { req, res, url, user, locale } = context;

      if ((url.pathname === '/api/admin/blog/tree' || url.pathname === '/api/blog/studio/tree') && req.method === 'GET') {
        return requireBlogEditor(context, () => context.sendJson(res, 200, getBlogStudioTree(context)));
      }
      if ((url.pathname === '/api/admin/blog/post' || url.pathname === '/api/blog/studio/post') && req.method === 'GET') {
        return requireBlogEditor(context, () => handleGetAdminBlogPost(context));
      }
      if ((url.pathname === '/api/admin/blog/post' || url.pathname === '/api/blog/studio/post') && req.method === 'POST') {
        return requireBlogEditor(context, async () => handleSaveAdminBlogPost(context));
      }
      if ((url.pathname.startsWith('/api/admin/blog/post/') || url.pathname.startsWith('/api/blog/studio/post/')) && req.method === 'DELETE') {
        return requireBlogEditor(context, () => handleDeleteAdminBlogPost(context));
      }

      if (url.pathname === '/admin/blog') {
        return requireBlogEditor(context, () => context.sendHtml(res, 200, renderBlogAdminPage(context)));
      }
      if (url.pathname === '/blog-studio') {
        return requireBlogEditor(context, () => context.redirect(res, `/admin/blog${url.search || ''}`));
      }

      if (url.pathname === '/blog') {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'blogFeatureDisabled', 'The blog feature is currently disabled.') }));
          return true;
        }
        context.sendHtml(res, 200, renderBlogIndexPage(context));
        return true;
      }

      if (url.pathname.startsWith('/blog/')) {
        if (!context.isPluginEnabled(feature.key)) {
          context.sendHtml(res, 404, context.renderFeatureHub({ user, locale, notice: context.tf(locale, 'blogFeatureDisabled', 'The blog feature is currently disabled.') }));
          return true;
        }
        const slug = decodeURIComponent(url.pathname.slice('/blog/'.length));
        const post = getBlogCatalog(context).bySlug.get(slug);
        if (!post) {
          context.sendHtml(res, 404, renderBlogIndexPage(context, { notice: context.t(locale, 'notFoundPage') }));
          return true;
        }
        if (!canReadBlogPost(user, post)) {
          context.sendHtml(res, 403, renderBlogIndexPage(context, { notice: context.t(locale, 'noPermission') }));
          return true;
        }
        context.sendHtml(res, 200, renderBlogPostPage(context, post));
        return true;
      }

      return false;
    }
  };

  function getBlogDir(context) {
    return join(context.ROOT, 'content', 'blog');
  }

  function requireBlogEditor(context, callback) {
    if (!canManageBlog(context.user)) {
      if (context.url.pathname.startsWith('/api/')) {
        context.sendJson(context.res, 403, { error: context.tf(context.locale, 'blogEditorApiRequired', 'Blog editor permissions required.') });
      } else {
        context.sendHtml(context.res, 403, renderBlogIndexPage(context, { notice: context.tf(context.locale, 'blogEditorRequired', 'Blog editor permissions are required.') }));
      }
      return true;
    }
    callback();
    return true;
  }

  function canManageBlog(user) {
    return Boolean(user?.is_admin || user?.roles?.includes('Blog-Editor'));
  }

  function canReadBlogPost(user, post) {
    if (user?.is_admin) return true;
    if (!post.roles.length) return true;
    return post.roles.some((role) => user.roles.includes(role));
  }

  function getBlogCatalog(context) {
    const blogDir = getBlogDir(context);
    context.logInfo(`Loading blog catalog from ${blogDir}`);
    if (!context.existsSync(blogDir)) {
      context.mkdirSync(blogDir, { recursive: true });
      return { posts: [], bySlug: new Map() };
    }
    const posts = readdirSync(blogDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => createBlogPost(context, join(blogDir, file), file.replace(/\.md$/i, '')))
      .sort((a, b) => compareBlogPosts(b, a));
    const bySlug = new Map(posts.map((post) => [post.slug, post]));
    context.logInfo(`Blog catalog loaded: ${posts.length} posts`);
    return { posts, bySlug };
  }

  function createBlogPost(context, filePath, slug) {
    const raw = context.readFileSync(filePath, 'utf8');
    const { meta, markdown } = context.parseFrontmatter(raw);
    const rendered = context.markdownToHtml(markdown, `blog/${slug}`);
    const stats = context.statSync(filePath);
    const publishedAt = normalizeBlogDate(meta.publishedAt || meta.date || meta.published || '');
    const updatedAt = normalizeBlogDate(meta.updatedAt || '') || stats.mtime.toISOString();
    const roles = Array.isArray(meta.roles) ? meta.roles : [];
    return {
      slug,
      file: filePath,
      title: meta.title || context.titleFromSlug(slug),
      description: meta.description || '',
      excerpt: meta.excerpt || meta.description || '',
      author: meta.author || '',
      coverImage: meta.coverImage || '',
      publishedAt: publishedAt || stats.mtime.toISOString(),
      updatedAt,
      roles,
      html: rendered.html,
      headings: rendered.headings,
      markdown
    };
  }

  function normalizeBlogDate(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function compareBlogPosts(a, b) {
    return new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime();
  }

  function getBlogStudioTree(context) {
    return {
      tree: getBlogCatalog(context).posts.map((post) => ({
        slug: post.slug,
        title: post.title,
        publishedAt: post.publishedAt,
        coverImage: post.coverImage,
        relativePath: `content/blog/${post.slug}.md`
      }))
    };
  }

  function getEditableBlogPost(context, slug) {
    const safeSlug = context.slugify(String(slug || '').trim());
    if (!safeSlug) return null;
    const filePath = normalize(join(getBlogDir(context), `${safeSlug}.md`));
    if (!filePath.startsWith(getBlogDir(context)) || !context.existsSync(filePath)) return null;
    const raw = context.readFileSync(filePath, 'utf8');
    const parsed = context.parseFrontmatter(raw);
    return {
      slug: safeSlug,
      filePath,
      relativePath: `content/blog/${safeSlug}.md`,
      markdown: parsed.markdown,
      meta: {
        title: String(parsed.meta.title || '').trim(),
        description: String(parsed.meta.description || '').trim(),
        excerpt: String(parsed.meta.excerpt || '').trim(),
        author: String(parsed.meta.author || '').trim(),
        coverImage: String(parsed.meta.coverImage || '').trim(),
        publishedAt: String(parsed.meta.publishedAt || parsed.meta.date || '').trim(),
        roles: Array.isArray(parsed.meta.roles) ? parsed.meta.roles : []
      }
    };
  }

  function handleGetAdminBlogPost(context) {
    const slug = String(context.url.searchParams.get('slug') || '').trim();
    const post = getEditableBlogPost(context, slug);
    if (!post) return context.sendJson(context.res, 404, { error: 'Blog post not found.' });
    context.sendJson(context.res, 200, post);
  }

  async function handleSaveAdminBlogPost(context) {
    const payload = await context.readJson(context.req);
    const mode = payload.mode === 'create' ? 'create' : 'update';
    const slug = context.slugify(String(payload.slug || '').trim());
    const title = String(payload.title || '').trim();
    const description = String(payload.description || '').trim();
    const excerpt = String(payload.excerpt || '').trim();
    const author = String(payload.author || context.user.name || '').trim();
    const coverImage = String(payload.coverImage || '').trim();
    const publishedAt = String(payload.publishedAt || '').trim();
    const roles = context.normalizeRoleList(payload.roles);
    const markdown = String(payload.markdown || '');

    if (!slug) return context.sendJson(context.res, 400, { error: 'A blog slug is required.' });
    if (!title) return context.sendJson(context.res, 400, { error: 'A blog title is required.' });

    const blogDir = getBlogDir(context);
    if (!context.existsSync(blogDir)) context.mkdirSync(blogDir, { recursive: true });
    const filePath = normalize(join(blogDir, `${slug}.md`));
    if (!filePath.startsWith(blogDir)) return context.sendJson(context.res, 400, { error: 'Invalid blog path.' });
    if (mode === 'create' && context.existsSync(filePath)) return context.sendJson(context.res, 409, { error: 'This blog post already exists.' });
    if (mode === 'update' && !context.existsSync(filePath)) return context.sendJson(context.res, 404, { error: 'Blog post not found.' });

    const raw = serializeBlogPost(context, {
      meta: {
        title,
        description,
        excerpt,
        author,
        publishedAt: publishedAt || new Date().toISOString().slice(0, 10),
        coverImage,
        roles
      },
      markdown: markdown.trim() || `# ${title}\n\n${context.tf(context.locale, 'blogWriteStoryHere', 'Write your story here.')}\n`
    });
    context.writeFileSync(filePath, context.ensureTrailingNewline(raw), 'utf8');
    context.logInfo(`Blog post ${mode === 'create' ? 'created' : 'updated'}: ${slug}`, { file: filePath });
    context.sendJson(context.res, 200, { ok: true, slug });
  }

  function handleDeleteAdminBlogPost(context) {
    const slug = context.slugify(decodeURIComponent(context.url.pathname.split('/').pop() || ''));
    if (!slug) return context.sendJson(context.res, 400, { error: 'Invalid blog slug.' });
    const filePath = normalize(join(getBlogDir(context), `${slug}.md`));
    if (!filePath.startsWith(getBlogDir(context)) || !context.existsSync(filePath)) {
      return context.sendJson(context.res, 404, { error: 'Blog post not found.' });
    }
    context.unlinkSync(filePath);
    context.sendJson(context.res, 200, { ok: true });
  }

  function serializeBlogPost(context, { meta, markdown = '' }) {
    const lines = ['---'];
    lines.push(`title: ${String(meta.title || '').trim()}`);
    if (meta.description) lines.push(`description: ${String(meta.description).trim()}`);
    if (meta.excerpt) lines.push(`excerpt: ${String(meta.excerpt).trim()}`);
    if (meta.author) lines.push(`author: ${String(meta.author).trim()}`);
    if (meta.publishedAt) lines.push(`publishedAt: ${String(meta.publishedAt).trim()}`);
    if (meta.coverImage) lines.push(`coverImage: ${String(meta.coverImage).trim()}`);
    lines.push(`roles: [${context.normalizeRoleList(meta.roles).join(', ')}]`);
    lines.push('---', '', String(markdown || '').replace(/\r\n/g, '\n').replace(/^\n+/, ''));
    return lines.join('\n');
  }

  function renderBlogIndexPage(context, { notice = '' } = {}) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const posts = getBlogCatalog(context).posts.filter((post) => canReadBlogPost(context.user, post));
    const featured = posts[0] || null;
    const gridPosts = featured ? posts.slice(1) : posts;
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/blog')}
        <main class="content blog-page">
          ${notice ? `<div class="notice">${context.escapeHtml(notice)}</div>` : ''}
          <section class="policy">
            <div class="policy-header blog-index-header">
              <div>
                <p class="eyebrow">${context.tf(context.locale, 'blog', 'Blog')}</p>
                <h1>${context.tf(context.locale, 'latestStories', 'Latest stories from Atlas')}</h1>
                <p>${context.tf(context.locale, 'latestStoriesText', 'Share updates, release notes, internal announcements and team insights in a format that works both in the browser and directly from Markdown files.')}</p>
              </div>
              <dl class="meta-grid">
                <div><dt>${context.tf(context.locale, 'posts', 'Posts')}</dt><dd>${posts.length}</dd></div>
                <div><dt>${context.tf(context.locale, 'latest', 'Latest')}</dt><dd>${featured ? context.escapeHtml(context.formatDisplayDate(featured.publishedAt, context.locale)) : '-'}</dd></div>
                <div><dt>${context.tf(context.locale, 'editing', 'Editing')}</dt><dd>${canManageBlog(context.user) ? `<a href="/admin/blog">${context.tf(context.locale, 'openStudio', 'Open studio')}</a>` : context.tf(context.locale, 'markdownBased', 'Markdown based')}</dd></div>
              </dl>
            </div>
            ${featured ? renderFeaturedBlogCard(context, featured) : ''}
            ${gridPosts.length ? `<div class="blog-card-grid">${gridPosts.map((post) => renderBlogCard(context, post)).join('')}</div>` : (!featured ? renderBlogEmptyState(context, canManageBlog(context.user)) : '')}
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: featureCopy.label, body, settings, locale: context.locale, pluginKeys: [feature.key] });
  }

  function renderFeaturedBlogCard(context, post) {
    return `
      <a class="featured-blog-card" href="/blog/${encodeURIComponent(post.slug)}">
        ${post.coverImage ? `<div class="featured-blog-media"><img src="${context.escapeAttribute(post.coverImage)}" alt=""></div>` : ''}
        <div class="featured-blog-copy">
          <span class="feature-card-label">${context.tf(context.locale, 'featuredPost', 'Featured post')}</span>
          <h2>${context.escapeHtml(post.title)}</h2>
          <p>${context.escapeHtml(post.excerpt || post.description || '')}</p>
          <div class="blog-card-meta">
            <span>${context.escapeHtml(context.formatDisplayDate(post.publishedAt, context.locale))}</span>
            <span>${context.escapeHtml(post.author || context.tf(context.locale, 'editorialTeam', 'Editorial team'))}</span>
          </div>
        </div>
      </a>
    `;
  }

  function renderBlogCard(context, post) {
    return `
      <a class="blog-card" href="/blog/${encodeURIComponent(post.slug)}">
        ${post.coverImage ? `<div class="blog-card-media"><img src="${context.escapeAttribute(post.coverImage)}" alt=""></div>` : ''}
        <div class="blog-card-body">
          <div class="blog-card-meta">
            <span>${context.escapeHtml(context.formatDisplayDate(post.publishedAt, context.locale))}</span>
            <span>${context.escapeHtml(post.author || context.tf(context.locale, 'editorialTeam', 'Editorial team'))}</span>
          </div>
          <h2>${context.escapeHtml(post.title)}</h2>
          <p>${context.escapeHtml(post.excerpt || post.description || '')}</p>
        </div>
      </a>
    `;
  }

  function renderBlogPostPage(context, post) {
    const settings = context.getSettings();
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/blog')}
        <main class="content blog-page">
          <article class="policy blog-article">
            <nav class="breadcrumbs" aria-label="Breadcrumb">
              <a class="crumb-home-icon" href="/" aria-label="Home">💠</a>
              <span class="crumb-separator">›</span>
              <a href="/blog">${context.tf(context.locale, 'blog', 'Blog')}</a>
              <span class="crumb-separator">›</span>
              <a class="current" href="/blog/${encodeURIComponent(post.slug)}">${context.escapeHtml(post.title)}</a>
            </nav>
            <header class="blog-hero">
              ${post.coverImage ? `<div class="blog-hero-media"><img src="${context.escapeAttribute(post.coverImage)}" alt=""></div>` : ''}
              <div class="blog-hero-copy">
                ${canManageBlog(context.user) ? `<div class="policy-admin-actions"><a class="button ghost policy-admin-button" href="/admin/blog?post=${encodeURIComponent(post.slug)}">${context.tf(context.locale, 'editPost', 'Edit post')}</a></div>` : ''}
                <p class="eyebrow">${context.tf(context.locale, 'blog', 'Blog')}</p>
                <h1>${context.escapeHtml(post.title)}</h1>
                <p>${context.escapeHtml(post.description || post.excerpt || '')}</p>
                <div class="blog-card-meta">
                  <span>${context.escapeHtml(context.formatDisplayDate(post.publishedAt, context.locale))}</span>
                  <span>${context.escapeHtml(post.author || context.tf(context.locale, 'editorialTeam', 'Editorial team'))}</span>
                </div>
              </div>
            </header>
            <div class="policy-body">
              <div class="markdown-body">${post.html}</div>
              ${context.renderToc(post)}
            </div>
          </article>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({ title: post.title, body, settings, locale: context.locale });
  }

  function renderBlogEmptyState(context, canEdit = false) {
    return `
      <section class="empty-state">
        <h1>${context.tf(context.locale, 'noBlogPosts', 'No blog posts yet')}</h1>
        <p>${canEdit ? context.tf(context.locale, 'noBlogPostsEditorText', 'Open Blog Studio to create the first article and publish it as Markdown.') : context.tf(context.locale, 'noBlogPostsText', 'No articles have been published yet. Please check back soon.')}</p>
      </section>
    `;
  }

  function renderBlogAdminPage(context) {
    const settings = context.getSettings();
    const featureCopy = context.getPluginFeatureCopy(feature.key, context.locale, feature);
    const body = `
      <div class="app-shell">
        ${context.renderTopbar(context.user, context.locale, '/admin/blog')}
        <main class="admin-page blog-studio-page">
          <div class="admin-header">
            <div>
              <h1>${context.escapeHtml(featureCopy.label)}</h1>
              <p class="hint">${context.escapeHtml(featureCopy.description)}</p>
            </div>
            <div class="panel-head-actions">
              <a class="button ghost" href="/blog">${context.tf(context.locale, 'openBlog', 'Open blog')}</a>
              <button class="button primary" type="button" data-new-blog-post>${context.tf(context.locale, 'createPost', 'Create post')}</button>
            </div>
          </div>
          <div id="blogStudioError" class="notice admin-error" hidden></div>
          ${context.renderAdminTabsNav(context.locale, { mode: 'links', activePluginKey: feature.key })}
          <section class="admin-grid blog-studio-grid">
            <div class="panel content-nav-panel">
              <div class="panel-head">
                <h2>${context.tf(context.locale, 'posts', 'Posts')}</h2>
              </div>
              <div id="blogPostTree" class="content-tree"></div>
            </div>
            <div class="panel content-editor-panel">
              <div class="panel-head">
                <h2 id="blogEditorTitle">${context.tf(context.locale, 'blogEditor', 'Blog editor')}</h2>
                <div class="panel-head-actions">
                  <a class="button ghost" id="openBlogPostButton" href="/blog" hidden>${context.tf(context.locale, 'open', 'Open')} ${context.tf(context.locale, 'blog', 'Blog')}</a>
                </div>
              </div>
              <div class="content-editor-body">
                <div id="blogEditorEmpty" class="empty-state content-empty-state">
                  <h1>${context.tf(context.locale, 'selectPost', 'Select a blog post')}</h1>
                  <p>${context.tf(context.locale, 'selectPostText', 'Use the list on the left or create a new post to start writing.')}</p>
                </div>
                <form id="blogEditorForm" class="modal-form" hidden>
                  <input name="slug" type="hidden">
                  <div class="content-meta">
                    <label>${context.tf(context.locale, 'postSlug', 'Post slug')} <input name="display_slug" readonly></label>
                    <label>${context.tf(context.locale, 'filePath', 'File path')} <input name="relative_path" readonly></label>
                    <label>${context.tf(context.locale, 'title', 'Title')} <input name="title" required></label>
                    <label>${context.tf(context.locale, 'author', 'Author')} <input name="author"></label>
                    <label>${context.tf(context.locale, 'publishedAt', 'Published at')} <input name="publishedAt" placeholder="2026-05-27"></label>
                    <label>${context.tf(context.locale, 'coverImageUrl', 'Cover image URL')} <input name="coverImage" placeholder="https://..."></label>
                    <label>${context.tf(context.locale, 'rolesCsv', 'Roles (comma separated)')} <input name="roles" placeholder="Users"></label>
                  </div>
                  <label>${context.tf(context.locale, 'description', 'Description')} <textarea name="description"></textarea></label>
                  <label>${context.tf(context.locale, 'excerpt', 'Excerpt')} <textarea name="excerpt"></textarea></label>
                  <label>${context.tf(context.locale, 'rawMarkdown', 'Raw Markdown')}
                    <textarea name="markdown" class="code-input content-raw-input" spellcheck="false"></textarea>
                  </label>
                  <div class="modal-actions">
                    <button class="button danger" type="button" data-delete-blog-post>${context.tf(context.locale, 'delete', 'Delete')}</button>
                    <button class="button primary" type="submit">${context.t(context.locale, 'save')}</button>
                  </div>
                </form>
              </div>
            </div>
          </section>
        </main>
        ${context.renderFooter(settings)}
      </div>
    `;
    return context.renderShell({
      title: featureCopy.label,
      body,
      settings,
      locale: context.locale,
      scripts: [context.pluginAssetUrl(feature.key, 'admin.js')],
      pluginKeys: [feature.key]
    });
  }
}
