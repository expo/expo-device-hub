#!/usr/bin/env python3
"""Summarize one complete, fixed six-pair browser batch without dropping invalid trials."""
import argparse
import json
from pathlib import Path
from statistics import median


def summarize(rows):
    if not rows:
        raise ValueError('No trials were recorded')
    batch_id = rows[-1]['batchId']
    batch = [row for row in rows if row['batchId'] == batch_id]
    expected = {(pair, variant) for pair in range(1, 7) for variant in ('tail', 'front')}
    actual = [(row['pair'], row['variant']) for row in batch]
    if len(actual) != 12 or set(actual) != expected:
        raise ValueError('The last batch must contain exactly six complete pairs')
    invalid = [{'pair': row['pair'], 'variant': row['variant'],
                'reasons': row.get('invalidReasons', [])}
               for row in batch if not row['valid']]
    report = {'batchId': batch_id, 'trials': batch, 'invalid': invalid}
    if invalid:
        report['conclusion'] = 'Batch invalid; retain all trials and do not claim improvement'
        return report
    report['summary'] = {
        variant: {key: median(row[key] for row in batch if row['variant'] == variant)
                  for key in ('loadedDataMs', 'firstVideoFrameCallbackMs', 'requestCount')}
        for variant in ('tail', 'front')
    }
    pairs = []
    for pair in range(1, 7):
        trials = sorted((row for row in batch if row['pair'] == pair), key=lambda row: row['order'])
        if [row['variant'] for row in trials] != (['tail', 'front'] if pair % 2 else ['front', 'tail']):
            raise ValueError('Pair order differs from the fixed AB/BA plan')
        by_variant = {row['variant']: row for row in trials}
        pairs.append({'pair': pair, 'order': [row['variant'] for row in trials],
                      'tailLoadedDataMs': by_variant['tail']['loadedDataMs'],
                      'frontLoadedDataMs': by_variant['front']['loadedDataMs'],
                      'tailRequests': by_variant['tail']['requestCount'],
                      'frontRequests': by_variant['front']['requestCount']})
    report['pairs'] = pairs
    tail = report['summary']['tail']['loadedDataMs']
    front = report['summary']['front']['loadedDataMs']
    report['medianLoadedDataReductionPercent'] = (tail - front) / tail * 100
    report['allPairsFrontFaster'] = all(pair['frontLoadedDataMs'] < pair['tailLoadedDataMs'] for pair in pairs)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.results.read_text().splitlines() if line.strip()]
    print(json.dumps(summarize(rows), indent=2))
