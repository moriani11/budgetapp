// Hulpfunctie om kalenderdatums (zonder tijdcomponent) correct te verwerken.
//
// Probleem dat dit oplost: `new Date("2024-01-15")` wordt door JavaScript
// geïnterpreteerd als middernacht UTC (00:00Z), niet als middernacht in de
// lokale tijdzone van de server. Wanneer die datum later ergens anders wordt
// weergegeven (bv. via toLocaleDateString of getDate()) in een tijdzone die
// achter loopt op UTC, verschuift de datum een dag terug. Dit veroorzaakte
// aankopen/transacties die op de verkeerde (vaak één dag te vroege) datum
// werden getoond.
//
// Door zuivere "YYYY-MM-DD" datums zelf te parsen met de lokale Date-
// constructor (jaar, maand, dag) in plaats van de ingebouwde UTC-parsing,
// blijft de kalenderdatum overal consistent, ongeacht de tijdzone van de
// server waarop de app draait.
export function parseDateOnly(input: string | Date | undefined | null): Date {
    if (!input) {
        return new Date();
    }

    if (input instanceof Date) {
        return input;
    }

    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());

    if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return new Date(
            parseInt(year, 10),
            parseInt(month, 10) - 1,
            parseInt(day, 10)
        );
    }

    // Bevat al een tijdcomponent (en eventueel tijdzone-offset): laat de
    // ingebouwde parser dit afhandelen, dat gaat wel correct om met UTC.
    const parsed = new Date(input);
    return parsed;
}

// Geeft een "YYYY-MM" maandsleutel terug op basis van de LOKALE kalenderdatum
// (niet de UTC-datum), zodat dit consistent is met parseDateOnly hierboven.
export function toMonthKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
}

// Geeft een "YYYY-MM-DD" waarde terug op basis van de LOKALE kalenderdatum,
// geschikt als value voor een <input type="date">. `toISOString().slice(0,10)`
// gebruikt de UTC-datum, waardoor rond middernacht (en zeker rond een
// maandwissel) de verkeerde (vaak één dag te vroege) datum werd voorgesteld.
export function toDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
