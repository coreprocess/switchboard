/** Times as people see them in Teams: `YYYY-MM-DD HH:mm` in Switchboard's time zone. */
export const formatLocal = (date: Date, timeZone: string): string => {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(date)
            .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/** Teams message IDs are the message's time in milliseconds; `undefined` for IDs of another shape. */
export const timeOfMessageId = (messageId: string): Date | undefined => {
    if (!/^\d{12,14}$/.test(messageId)) return undefined;
    return new Date(Number(messageId));
};

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
