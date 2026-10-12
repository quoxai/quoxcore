// "down" as an outage: a subject (is/went/site/api...) within a few words of a
// standalone "down". A bare /down/ also matched "jot this down", "write that
// down", "download", "markdown" and "breakdown" (AQ-9D scorecard, 2026-10-07).
export const OUTAGE_DOWN = /\b(?:is|are|was|were|went|go|goes|gone|going|been|it|site|server|service|host|api|app|website|everything)\b(?:\s+\w+){0,3}\s+down\b/
