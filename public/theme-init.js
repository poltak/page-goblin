// Sets the theme before the first paint, so the page does not flash the wrong colours.
// Keep the key, the rules and the colours the same as in src/lib/settings.
// A test compares this file with resolveTheme.
;(function () {
    var colors = { light: '#fbfaf8', sepia: '#f4ecd8', dark: '#1d1d1b', black: '#000000' }
    var saved = null
    try {
        saved = JSON.parse(localStorage.getItem('page-goblin:settings'))
    } catch (error) {
        // Blocked storage and bad data give the defaults.
    }
    try {
        saved = saved || {}
        var theme = saved.theme
        if (typeof theme !== 'string' || !colors.hasOwnProperty(theme)) {
            // 'auto' and each value that is not valid follow the system.
            var systemDark =
                typeof matchMedia === 'function' &&
                matchMedia('(prefers-color-scheme: dark)').matches
            theme = !systemDark ? 'light' : saved.darkTheme === 'black' ? 'black' : 'dark'
        }
        var root = document.documentElement
        root.dataset.theme = theme
        // The black theme can be darker than the screen and can have warm text.
        var dim = saved.blackBrightness
        dim = typeof dim === 'number' ? Math.round(Math.min(100, Math.max(20, dim)) / 5) / 20 : 1
        if (theme === 'black' && dim < 1) {
            root.setAttribute('data-black-dim', '')
            root.style.setProperty('--black-brightness', String(dim))
        }
        var tint = saved.blackTint
        if (theme === 'black' && (tint === 'amber' || tint === 'red')) root.dataset.blackTint = tint
        // A reload inside a book must not paint the library first. The app shell removes this.
        if (location.hash.indexOf('#/book/') === 0) root.dataset.route = 'book'
        var meta = document.querySelector('meta[name="theme-color"]')
        if (meta) meta.setAttribute('content', colors[theme])
    } catch (error) {
        // The app sets the theme when it starts.
    }
})()
