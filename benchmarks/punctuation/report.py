import json, sys
d=json.load(sys.stdin)
for f,v in d.items():
  print(f, "n=%d"%v["n"])
  for k in ('own','pnc','pncStrip'):
    s=v[k]; print("  %-8s end F1 %.3f | mid-clip end F1 %.3f (P %.2f R %.2f) | comma F1 %.3f (P %.2f R %.2f) | capAcc %.4f capF1 %.3f | doubled/100w %.2f"%(k,s['endF1'][0],s['midEndF1'][0],s['midEndF1'][1],s['midEndF1'][2],s['commaF1'][0],s['commaF1'][1],s['commaF1'][2],s['capAcc'],s['capF1'][0],s['doubledPer100']), s['counts'])
