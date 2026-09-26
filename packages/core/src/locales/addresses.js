// Compact per-locale address parts. Street lines are composed at generation time as
// `${number} ${street}`; city, region and postal code come from the city list.

export const US_ADDRESS_PARTS = {
  cities: [
    ["Austin", "TX", "78701"],
    ["Denver", "CO", "80202"],
    ["Chicago", "IL", "60601"],
    ["Seattle", "WA", "98101"],
    ["Miami", "FL", "33131"],
    ["Boston", "MA", "02110"],
    ["Portland", "OR", "97204"],
    ["Nashville", "TN", "37203"],
    ["Phoenix", "AZ", "85004"],
    ["Atlanta", "GA", "30303"],
    ["San Diego", "CA", "92101"],
    ["Minneapolis", "MN", "55402"]
  ],
  streets:
    "Main St|Oak Ave|Maple St|Cedar Ln|Park Blvd|Lakeview Dr|Commerce Way|Pine St|Elm St|Market St"
};

export const GB_ADDRESS_PARTS = {
  cities: [
    ["London", "Greater London", "EC2A 4NE"],
    ["Birmingham", "West Midlands", "B1 2JB"],
    ["Manchester", "Greater Manchester", "M3 3HF"],
    ["Leeds", "West Yorkshire", "LS1 4AP"],
    ["Bristol", "Bristol", "BS1 6DG"],
    ["Newcastle upon Tyne", "Tyne and Wear", "NE1 4AD"],
    ["Glasgow", "Glasgow", "G2 1RW"],
    ["Edinburgh", "Edinburgh", "EH1 2HE"],
    ["Cardiff", "South Glamorgan", "CF10 1EP"],
    ["Nottingham", "Nottinghamshire", "NG1 5FS"]
  ],
  streets:
    "High Street|Station Road|Church Lane|Victoria Road|Mill Lane|King Street|Park Road|London Road|Queens Road|Albert Street"
};

export const AU_ADDRESS_PARTS = {
  cities: [
    ["Sydney", "NSW", "2000"],
    ["Melbourne", "VIC", "3000"],
    ["Brisbane", "QLD", "4000"],
    ["Perth", "WA", "6000"],
    ["Adelaide", "SA", "5000"],
    ["Hobart", "TAS", "7000"],
    ["Canberra", "ACT", "2601"],
    ["Newcastle", "NSW", "2300"],
    ["Geelong", "VIC", "3220"],
    ["Gold Coast", "QLD", "4217"]
  ],
  streets:
    "George St|King St|Pacific Hwy|Victoria Rd|Church St|Beach Rd|Station St|Queen St|High St|Military Rd"
};

export const CA_ADDRESS_PARTS = {
  cities: [
    ["Toronto", "ON", "M5X 1A1"],
    ["Montreal", "QC", "H3B 4W8"],
    ["Vancouver", "BC", "V6C 3L6"],
    ["Calgary", "AB", "T2P 3Y7"],
    ["Winnipeg", "MB", "R3C 3Z3"],
    ["Halifax", "NS", "B3J 3K9"],
    ["Edmonton", "AB", "T5J 3S4"],
    ["Ottawa", "ON", "K1P 1J1"],
    ["Victoria", "BC", "V8W 1P6"],
    ["Saskatoon", "SK", "S7K 1J5"]
  ],
  streets:
    "King St W|Yonge St|Main St|Queen St E|Maple Ave|Bay St|Wellington St|Portage Ave|Jasper Ave|Rue Sainte-Catherine"
};
