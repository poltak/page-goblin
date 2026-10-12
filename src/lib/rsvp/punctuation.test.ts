import { describe, expect, test } from 'vitest'
import { endsSentence, getPunctuationMultiplier } from './punctuation'

describe('getPunctuationMultiplier', () => {
    describe('basic punctuation', () => {
        test('gives the period multiplier for a word that ends with a period', () => {
            expect(getPunctuationMultiplier('hello.')).toBe(3)
            expect(getPunctuationMultiplier('world.')).toBe(3)
            expect(getPunctuationMultiplier('sentence.')).toBe(3)
        })

        test('gives the comma multiplier for a word that ends with a comma', () => {
            expect(getPunctuationMultiplier('hello,')).toBe(2)
            expect(getPunctuationMultiplier('world,')).toBe(2)
            expect(getPunctuationMultiplier('however,')).toBe(2)
        })

        test('gives the semicolon multiplier for a word that ends with a semicolon', () => {
            expect(getPunctuationMultiplier('hello;')).toBe(2.5)
            expect(getPunctuationMultiplier('world;')).toBe(2.5)
        })

        test('gives the semicolon multiplier for a word that ends with a colon', () => {
            expect(getPunctuationMultiplier('hello:')).toBe(2.5)
            expect(getPunctuationMultiplier('follows:')).toBe(2.5)
        })

        test('gives the exclamation multiplier for a word that ends with an exclamation mark', () => {
            expect(getPunctuationMultiplier('hello!')).toBe(3)
            expect(getPunctuationMultiplier('wow!')).toBe(3)
        })

        test('gives the exclamation multiplier for a word that ends with a question mark', () => {
            expect(getPunctuationMultiplier('hello?')).toBe(3)
            expect(getPunctuationMultiplier('really?')).toBe(3)
        })

        test('gives 1 for a word with no punctuation', () => {
            expect(getPunctuationMultiplier('hello')).toBe(1)
            expect(getPunctuationMultiplier('world')).toBe(1)
            expect(getPunctuationMultiplier('test123')).toBe(1)
        })
    })

    describe('punctuation with trailing quotes and brackets', () => {
        test('finds punctuation before double quotes', () => {
            expect(getPunctuationMultiplier('hello."')).toBe(3)
            expect(getPunctuationMultiplier('said,"')).toBe(2)
            expect(getPunctuationMultiplier('yes!"')).toBe(3)
            expect(getPunctuationMultiplier('why?"')).toBe(3)
        })

        test('finds punctuation before single quotes', () => {
            expect(getPunctuationMultiplier("hello.'")).toBe(3)
            expect(getPunctuationMultiplier("said,'")).toBe(2)
            expect(getPunctuationMultiplier("yes!'")).toBe(3)
            expect(getPunctuationMultiplier("why?'")).toBe(3)
        })

        test('finds punctuation before curly quotes', () => {
            expect(getPunctuationMultiplier('hello.\u2019')).toBe(3)
            expect(getPunctuationMultiplier('hello.\u201D')).toBe(3)
            expect(getPunctuationMultiplier('said,\u2019')).toBe(2)
            expect(getPunctuationMultiplier('said,\u201D')).toBe(2)
        })

        test('finds punctuation before parentheses', () => {
            expect(getPunctuationMultiplier('hello.)')).toBe(3)
            expect(getPunctuationMultiplier('said,)')).toBe(2)
            expect(getPunctuationMultiplier('yes!)')).toBe(3)
            expect(getPunctuationMultiplier('why?)')).toBe(3)
        })

        test('finds punctuation before brackets', () => {
            expect(getPunctuationMultiplier('hello.]')).toBe(3)
            expect(getPunctuationMultiplier('said,]')).toBe(2)
            expect(getPunctuationMultiplier('yes!]')).toBe(3)
            expect(getPunctuationMultiplier('why?]')).toBe(3)
        })

        test('finds punctuation before more than one trailing character', () => {
            expect(getPunctuationMultiplier('hello.")')).toBe(3)
            expect(getPunctuationMultiplier('said,")]')).toBe(2)
            expect(getPunctuationMultiplier('yes!"]')).toBe(3)
        })
    })

    describe('citation marks', () => {
        test('finds punctuation before bracket citations', () => {
            expect(getPunctuationMultiplier('sentence.[1]')).toBe(3)
            expect(getPunctuationMultiplier('statement.[12]')).toBe(3)
            expect(getPunctuationMultiplier('fact.[123]')).toBe(3)
            expect(getPunctuationMultiplier('quote.[4567]')).toBe(3)
        })

        test('finds punctuation before parenthesis citations', () => {
            expect(getPunctuationMultiplier('sentence.(1)')).toBe(3)
            expect(getPunctuationMultiplier('statement.(12)')).toBe(3)
            expect(getPunctuationMultiplier('fact.(123)')).toBe(3)
            expect(getPunctuationMultiplier('quote.(4567)')).toBe(3)
        })

        test('finds a comma before a citation', () => {
            expect(getPunctuationMultiplier('however,[1]')).toBe(2)
            expect(getPunctuationMultiplier('furthermore,(2)')).toBe(2)
        })

        test('finds other punctuation before a citation', () => {
            expect(getPunctuationMultiplier('listed;[1]')).toBe(2.5)
            expect(getPunctuationMultiplier('follows:(2)')).toBe(2.5)
            expect(getPunctuationMultiplier('amazing![3]')).toBe(3)
            expect(getPunctuationMultiplier('really?(4)')).toBe(3)
        })

        test('finds punctuation before a citation and a quote', () => {
            expect(getPunctuationMultiplier('sentence.[1]"')).toBe(3)
            expect(getPunctuationMultiplier("statement.(2)'")).toBe(3)
            expect(getPunctuationMultiplier('quote,[3]"')).toBe(2)
            expect(getPunctuationMultiplier('said.(4)\u2019')).toBe(3)
        })
    })

    describe('edge cases', () => {
        test('gives 1 for an empty string', () => {
            expect(getPunctuationMultiplier('')).toBe(1)
        })

        test('gives 1 for a string of only quotes', () => {
            expect(getPunctuationMultiplier('"')).toBe(1)
            expect(getPunctuationMultiplier("'")).toBe(1)
            expect(getPunctuationMultiplier('"""')).toBe(1)
        })

        test('gives 1 for a string of only brackets', () => {
            expect(getPunctuationMultiplier(']')).toBe(1)
            expect(getPunctuationMultiplier(')')).toBe(1)
            expect(getPunctuationMultiplier('}')).toBe(1)
        })

        test('gives 1 for a citation with no punctuation', () => {
            expect(getPunctuationMultiplier('word[1]')).toBe(1)
            expect(getPunctuationMultiplier('word(2)')).toBe(1)
        })

        test('handles bracket groups that are not citations', () => {
            expect(getPunctuationMultiplier('word.[abc]')).toBe(3)
            expect(getPunctuationMultiplier('word.[]')).toBe(3)
            expect(getPunctuationMultiplier('word.[1')).toBe(1)
            expect(getPunctuationMultiplier('word.1]')).toBe(1)
        })

        test('handles a bracket that closes with the other type', () => {
            expect(getPunctuationMultiplier('word.[1)')).toBe(3)
            expect(getPunctuationMultiplier('word.(1]')).toBe(3)
        })

        test('handles more than one citation', () => {
            expect(getPunctuationMultiplier('word.[1][2]')).toBe(3)
            expect(getPunctuationMultiplier('word.,[1][2]')).toBe(2)
        })

        test('handles words that end with a dash or the ellipsis character', () => {
            expect(getPunctuationMultiplier('word\u2014')).toBe(1)
            expect(getPunctuationMultiplier('word\u2013')).toBe(1)
            expect(getPunctuationMultiplier('word\u2026')).toBe(1)
            expect(getPunctuationMultiplier('sentence.\u2014')).toBe(3)
            expect(getPunctuationMultiplier('sentence.\u2026')).toBe(3)
        })

        test('handles the other skippable characters', () => {
            expect(getPunctuationMultiplier('fin.\u00BB')).toBe(3)
            expect(getPunctuationMultiplier('fin,\u203A')).toBe(2)
            expect(getPunctuationMultiplier('end.}')).toBe(3)
            expect(getPunctuationMultiplier('end.-')).toBe(3)
            expect(getPunctuationMultiplier('end.\u2010')).toBe(3)
            expect(getPunctuationMultiplier('end.\u201C')).toBe(3)
            expect(getPunctuationMultiplier('end.\u2018')).toBe(3)
            expect(getPunctuationMultiplier('end.\u00AB')).toBe(3)
            expect(getPunctuationMultiplier('end.\u2039')).toBe(3)
        })

        test('looks only at the end of the word', () => {
            expect(getPunctuationMultiplier('3.14')).toBe(1)
            expect(getPunctuationMultiplier('e.g')).toBe(1)
            expect(getPunctuationMultiplier("don't")).toBe(1)
            expect(getPunctuationMultiplier('word[1]text')).toBe(1)
            expect(getPunctuationMultiplier('word[1].')).toBe(3)
        })

        test('stays fast and correct for a very long token', () => {
            const long = 'a'.repeat(50000)
            expect(getPunctuationMultiplier(long)).toBe(1)
            expect(getPunctuationMultiplier(`${long}.`)).toBe(3)
            expect(getPunctuationMultiplier(`${long},[12]"`)).toBe(2)

            const started = performance.now()
            expect(getPunctuationMultiplier(`${'('.repeat(50000)})`)).toBe(1)
            expect(getPunctuationMultiplier(`${'['.repeat(50000)}.`)).toBe(3)
            expect(performance.now() - started).toBeLessThan(200)
        })
    })

    describe('custom multipliers', () => {
        const multipliers = {
            periodMultiplier: 5,
            commaMultiplier: 3,
            semicolonMultiplier: 4,
            exclamationMultiplier: 6,
        }

        test('uses the multipliers that the caller gives', () => {
            expect(getPunctuationMultiplier('hello.', multipliers)).toBe(5)
            expect(getPunctuationMultiplier('hello,', multipliers)).toBe(3)
            expect(getPunctuationMultiplier('hello;', multipliers)).toBe(4)
            expect(getPunctuationMultiplier('hello:', multipliers)).toBe(4)
            expect(getPunctuationMultiplier('hello!', multipliers)).toBe(6)
            expect(getPunctuationMultiplier('hello?', multipliers)).toBe(6)
            expect(getPunctuationMultiplier('hello', multipliers)).toBe(1)
        })
    })

    describe('examples from real books', () => {
        test('handles academic citations', () => {
            expect(getPunctuationMultiplier('research.[1]')).toBe(3)
            expect(getPunctuationMultiplier('findings.[23]')).toBe(3)
            expect(getPunctuationMultiplier('study,(Smith)')).toBe(2)
            expect(getPunctuationMultiplier('data.(2019)')).toBe(3)
        })

        test('handles dialogue in quotes', () => {
            expect(getPunctuationMultiplier('"Hello."')).toBe(3)
            expect(getPunctuationMultiplier('"Yes,"')).toBe(2)
            expect(getPunctuationMultiplier('"Really?"')).toBe(3)
            expect(getPunctuationMultiplier('"Wow!"')).toBe(3)
        })

        test('handles nested punctuation', () => {
            expect(getPunctuationMultiplier('said.[1]"),')).toBe(2)
            expect(getPunctuationMultiplier('however,[2]"\u2014')).toBe(2)
        })
    })
})

describe('endsSentence', () => {
    test('is true for a period, an exclamation mark and a question mark', () => {
        expect(endsSentence('done.')).toBe(true)
        expect(endsSentence('Stop!')).toBe(true)
        expect(endsSentence('why?')).toBe(true)
        expect(endsSentence('what?!')).toBe(true)
        expect(endsSentence('wait...')).toBe(true)
    })

    test('is true for the ellipsis character', () => {
        expect(endsSentence('wait\u2026')).toBe(true)
        expect(endsSentence('wait\u2026\u201D')).toBe(true)
        expect(endsSentence('wait.\u2026')).toBe(true)
        expect(endsSentence('\u2026')).toBe(true)
    })

    test('ignores trailing quotes, brackets, dashes and citations', () => {
        expect(endsSentence('"Stop!"')).toBe(true)
        expect(endsSentence('said.\u201D')).toBe(true)
        expect(endsSentence("gone.')")).toBe(true)
        expect(endsSentence('all).')).toBe(true)
        expect(endsSentence('all.)')).toBe(true)
        expect(endsSentence('fact.[12]')).toBe(true)
        expect(endsSentence('fact.(3)"')).toBe(true)
        expect(endsSentence('end.\u2014')).toBe(true)
    })

    test('is false for all other words', () => {
        expect(endsSentence('word')).toBe(false)
        expect(endsSentence('word,')).toBe(false)
        expect(endsSentence('word;')).toBe(false)
        expect(endsSentence('word:')).toBe(false)
        expect(endsSentence('word\u2014')).toBe(false)
        expect(endsSentence('"word"')).toBe(false)
        expect(endsSentence('word[1]')).toBe(false)
        expect(endsSentence('3.14')).toBe(false)
        expect(endsSentence('')).toBe(false)
    })
})
