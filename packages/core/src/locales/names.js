// Compact per-locale name parts used to compose person and company names.
// Lists are "|"-separated strings to keep this file small; see splitList() in ../names.js.

export const US_NAME_PARTS = {
  first:
    "James|Maria|Robert|Linda|David|Sarah|Michael|Jennifer|Marcus|Jessica|Daniel|Emily|Thomas|Rachel|Andrew|Priya|Luis|Grace",
  last: "Carter|Nguyen|Patel|Brooks|Ramirez|Sullivan|Kim|Bennett|Foster|Hayes|Coleman|Reyes|Morgan|Ellis|Warren|Chen|Delgado|Harper",
  places:
    "Summit|Cascade|Redwood|Lakeshore|Prairie|Harbor|Keystone|Canyon|Evergreen|Northstar|Bluewater|Ridgeline",
  legal: "LLC|Inc.|Co.|Group"
};

export const GB_NAME_PARTS = {
  first:
    "Oliver|Charlotte|George|Amelia|Harry|Sophie|Jack|Isla|Arjun|Thomas|Grace|William|Lily|Edward|Hannah|Callum|Freya|Imran",
  last: "Whitmore|Ashworth|Pembroke|Hughes|Fletcher|Barnes|Holloway|Kaur|Clarke|Thornton|Sutton|Blackwood|Evans|Marsh|Ahmed|Hartley",
  places:
    "Thames|Pennine|Cotswold|Kingsway|Albion|Hawthorn|Riverside|Wessex|Northgate|Chiltern|Mercia|Severn",
  legal: "Ltd|LLP|& Co|Group"
};

export const AU_NAME_PARTS = {
  first:
    "Jack|Olivia|William|Charlotte|Noah|Amelia|Oliver|Mia|Lachlan|James|Ella|Thomas|Chloe|Liam|Ethan|Matilda|Kai|Zara",
  last: "Mitchell|Nguyen|Kelly|Walker|Campbell|Ryan|Murray|Doyle|Tran|Fraser|Lawson|Russo|Barker|Singh|Duncan|Hudson|Pearce|Quinn",
  places:
    "Harbour|Coastal|Wattle|Banksia|Bayside|Coral|Ironbark|Tasman|Pacific|Southern Cross|Red Gum|Kookaburra",
  legal: "Pty Ltd|Pty Ltd|Group|& Co"
};

export const CA_NAME_PARTS = {
  first:
    "Liam|Olivia|Noah|Emma|William|Charlotte|Benjamin|Amelia|Mathieu|Sophia|Ethan|Ava|Alexander|Isabella|Daniel|Chloe|Harpreet|Leo",
  last: "Tremblay|Gagnon|Roy|MacDonald|Wong|Bouchard|Fraser|Leblanc|Singh|Pelletier|Campbell|Chan|Morin|Stewart|Girard|Bergeron|Lavoie|Grant",
  places:
    "Maple|Northern|Laurentian|Cedar|Boreal|Rideau|Muskoka|Glacier|Fundy|Algonquin|Prairie|Pacific Rim",
  legal: "Inc.|Ltd.|Group|& Co"
};

// Industry-flavoured nouns. `customers` describes who the business invoices,
// `vendors` who it buys from. Industries without a customer list sell to a broad
// mix of businesses (GENERIC_CLIENTS).
export const GENERIC_CLIENTS =
  "Logistics|Manufacturing|Builders|Foods|Health Partners|Capital|Engineering|Media|Energy|Properties|Technologies|Architects|Distribution|Hospitality";

export const INDUSTRY_NOUNS = {
  "professional-services": {
    vendors:
      "Office Interiors|IT Solutions|Staffing|Print & Design|Insurance Agency|Travel|Software|Communications"
  },
  saas: {
    vendors:
      "Cloud Hosting|Data Centers|Software|Security|Marketing Agency|Hardware|Telecom|Analytics"
  },
  restaurant: {
    customers: "Events|Weddings|Catering|Hotel|Corporate Dining|Conference Venue|Film Studios",
    vendors:
      "Produce|Seafood|Meats|Beverage Distributors|Linen Service|Bakery Supply|Restaurant Supply|Dairy"
  },
  construction: {
    customers: "Developments|Homes|Property Group|Realty|School District|Holdings|Hospitality",
    vendors:
      "Lumber|Concrete|Equipment Rental|Electrical Supply|Plumbing Supply|Roofing|Steel|Hardware"
  },
  retail: {
    customers: "Boutique|Gift Shop|Outfitters|Market|General Store|Home Goods|Trading Post",
    vendors: "Wholesale|Apparel|Packaging|Distributors|Imports|Display & Fixtures|Freight|Trading"
  },
  healthcare: {
    customers: "Health Plan|Mutual Insurance|Care Network|Employee Benefits|Health Trust|Clinic",
    vendors:
      "Medical Supply|Laboratories|Pharmaceuticals|Dental Supply|Imaging|Linen Service|Biomedical|Billing Services"
  },
  nonprofit: {
    customers:
      "Foundation|Family Foundation|Community Fund|Charitable Trust|Giving Circle|Arts Council",
    vendors:
      "Printing|Event Services|Catering|Communications|Office Supply|Facilities|Consulting|Mailing Services"
  },
  "real-estate": {
    customers: "Dental|Coffee Co|Fitness|Law Office|Bakery|Pharmacy|Insurance|Salon",
    vendors:
      "Property Maintenance|Landscaping|Janitorial|HVAC|Plumbing|Security Services|Elevator Services|Roofing"
  }
};
