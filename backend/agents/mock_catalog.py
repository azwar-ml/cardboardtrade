"""Structured dashboard fixtures. Replace values with API-backed snapshots later."""

MOCK_AGENTS = [
    {"id":"supplier-discovery","name":"Supplier Discovery","group":"supplier","purpose":"Find candidate manufacturers from approved sources.","metrics":{"Candidates reviewed":24,"New leads":6,"Needs review":3},"activity":["6 candidate profiles staged","3 product claims flagged for human review","No supplier contacted"]},
    {"id":"supplier-qualification","name":"Supplier Qualification","group":"supplier","purpose":"Track evidence, certifications and export readiness.","metrics":{"Profiles checked":18,"Evidence complete":11,"Open checks":7},"activity":["2 certificate expiry checks pending","5 product mappings remain provisional","No qualification decision made"]},
    {"id":"supplier-catalog","name":"Supplier Catalog Intake","group":"supplier","purpose":"Prepare supplier files for operator review and import.","metrics":{"Files staged":8,"Rows parsed":146,"Exceptions":9},"activity":["9 rows held for validation","Duplicate SKU check enabled","Nothing published"]},
    {"id":"supplier-stock","name":"Supplier Stock Monitor","group":"supplier","purpose":"Surface expiring, low quantity and stale inventory.","metrics":{"Lots monitored":189,"Expiring soon":12,"Stock alerts":5},"activity":["12 price validity dates need confirmation","5 lots are below minimum stock threshold","No inventory changed"]},
    {"id":"buyer-discovery","name":"Buyer Discovery","group":"buyer","purpose":"Organize potential buyers by market and packaging needs.","metrics":{"Accounts reviewed":42,"Potential fits":17,"Unverified":8},"activity":["17 account records staged","8 require source verification","No buyer contacted"]},
    {"id":"buyer-intent","name":"Buyer Intent Signals","group":"buyer","purpose":"Summarize buyer interests and recorded RFQ activity.","metrics":{"Signals reviewed":31,"Recent RFQs":9,"Stale signals":4},"activity":["9 demo RFQ signals grouped","4 records need updated dates","No buyer records modified"]},
    {"id":"buyer-matching","name":"Buyer Match Assistant","group":"buyer","purpose":"Preview explainable buyer to inventory matches.","metrics":{"Matches previewed":28,"High fit":10,"Blocked by rules":6},"activity":["Scores use sample interest and inventory data","Buyer blocks and email caps are represented","No messages generated"]},
    {"id":"buyer-rfq","name":"Buyer RFQ Triage","group":"buyer","purpose":"Group enquiries and suggest operator follow-up queues.","metrics":{"Enquiries triaged":13,"Urgent":3,"Unassigned":2},"activity":["3 demo enquiries marked urgent","2 require account assignment","No replies sent"]},
    {"id":"ops-pricing","name":"Pricing & Margin Guard","group":"shared","purpose":"Flag invalid rates, margin drift and quote anomalies.","metrics":{"Quotes sampled":36,"Price flags":2,"FX status":"Valid"},"activity":["2 sample quotes need review","FX must be finite and greater than zero","No prices updated"]},
    {"id":"ops-compliance","name":"Policy & Data Guard","group":"shared","purpose":"Review privacy, permissions and communication policy checks.","metrics":{"Checks passed":"14/16","Open findings":2,"Channel":"Email only"},"activity":["Two sample records require operator review","Supplier identity and internal cost checks enabled","No outreach or calls"]},
]

for agent in MOCK_AGENTS:
    agent["status"] = "demo"
    agent["mode"] = "mock"
