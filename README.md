# Waxgadget - some wax blockchain tools

Staked.tsx:
given a list of template_ids, query all transfers to wombatmaster, make a list 
of the senders and look them up from the "staked" tables in wombatmaster wax 
contract. combine asset_ids / owners / template_ids into a list of accounts 
who are staking.
optional configuration with a multiplier per template, so some templates would 
get multiple entries. would be used when raffling out and airdropping gifts 
with chance based on the ownership of a collection's NFTs per account.

Web App using Vite + React + Typescript + Tailwind CSS
