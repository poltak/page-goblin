// Sets the theme before the first paint, so the page does not flash the wrong colours.
// Keep the key, the rule and the colours the same as in src/lib/settings (store.ts, theme.ts).
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
        document.documentElement.dataset.theme = theme
        // A reload inside a book must not paint the library first. The app shell removes this.
        if (location.hash.indexOf('#/book/') === 0) document.documentElement.dataset.route = 'book'
        var meta = document.querySelector('meta[name="theme-color"]')
        if (meta) meta.setAttribute('content', colors[theme])
    } catch (error) {
        // The app sets the theme when it starts.
    }
})()
