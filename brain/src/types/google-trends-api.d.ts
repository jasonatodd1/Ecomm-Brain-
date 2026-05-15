declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
    timezone?: number;
    category?: number;
    property?: string;
    resolution?: string;
    granularTimeResolution?: boolean;
  }

  function interestOverTime(opts: TrendsOptions): Promise<string>;
  function relatedQueries(opts: TrendsOptions): Promise<string>;
  function relatedTopics(opts: TrendsOptions): Promise<string>;
  function dailyTrends(opts: TrendsOptions): Promise<string>;
  function realTimeTrends(opts: TrendsOptions): Promise<string>;
  function interestByRegion(opts: TrendsOptions): Promise<string>;
  function autoComplete(opts: { keyword: string; hl?: string }): Promise<string>;

  const _default: {
    interestOverTime: typeof interestOverTime;
    relatedQueries: typeof relatedQueries;
    relatedTopics: typeof relatedTopics;
    dailyTrends: typeof dailyTrends;
    realTimeTrends: typeof realTimeTrends;
    interestByRegion: typeof interestByRegion;
    autoComplete: typeof autoComplete;
  };
  export default _default;
}
