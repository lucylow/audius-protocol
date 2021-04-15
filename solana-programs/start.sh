eth_account=$(python -c "from web3.auto import w3; a = w3.eth.account.create(); print(a.address[2:], a.privateKey.hex()[2:])")
address=$(echo $eth_account | cut -d' ' -f1)
priv_key=$(echo $eth_account | cut -d' ' -f2)

solana config set -u devnet

solana-keygen new -s --no-bip39-passphrase
solana-keygen new -s --no-bip39-passphrase -o feepayer.json
solana-keygen new -s --no-bip39-passphrase -o owner.json

solana airdrop --faucet-host 35.199.181.141 1
solana airdrop --faucet-host 35.199.181.141 1
solana airdrop --faucet-host 35.199.181.141 1
solana airdrop --faucet-host 35.199.181.141 1
solana airdrop --faucet-host 35.199.181.141 1

solana airdrop --faucet-host 35.199.181.141 1 feepayer.json
solana airdrop --faucet-host 35.199.181.141 1 feepayer.json
solana airdrop --faucet-host 35.199.181.141 1 feepayer.json
solana airdrop --faucet-host 35.199.181.141 1 feepayer.json
solana airdrop --faucet-host 35.199.181.141 1 feepayer.json

solana airdrop --faucet-host 35.199.181.141 1 owner.json
solana airdrop --faucet-host 35.199.181.141 1 owner.json
solana airdrop --faucet-host 35.199.181.141 1 owner.json
solana airdrop --faucet-host 35.199.181.141 1 owner.json
solana airdrop --faucet-host 35.199.181.141 1 owner.json

cd program
cargo build-bpf
solana-keygen new -s --no-bip39-passphrase -o target/deploy/audius-keypair.json --force
cur_address=$(grep -Po '(?<=declare_id!\(").*(?=")' src/lib.rs)
new_address=$(solana program deploy target/deploy/audius.so --output json | jq -r '.programId')
sed -i "s/$cur_address/$new_address/g" src/lib.rs

cd ../create_and_verify
cargo build-bpf
solana-keygen new -s --no-bip39-passphrase -o target/deploy/solana_program_template-keypair.json --force
cur_address=$(grep -Po '(?<=declare_id!\(").*(?=")' src/lib.rs)
new_address=$(solana program deploy target/deploy/solana_program_template.so --output json | jq -r '.programId')
sed -i "s/$cur_address/$new_address/g" src/lib.rs

cd ../cli
signer_group=$(cargo run create-signer-group | grep -Po '(?<=account ).*')
valid_signer=$(cargo run create-valid-signer "$signer_group" "$address" | grep -Po '(?<=account ).*')

cd ..
cat > solana-program-config.json <<EOF
{
    "createAndVerifyAddress": "$(grep -Po '(?<=declare_id!\(").*(?=")' create_and_verify/src/lib.rs)",
    "programAddress": "$(grep -Po '(?<=declare_id!\(").*(?=")' program/src/lib.rs)",
    "validSigner": "$valid_signer",
    "feePayerWallet": $(cat feepayer.json),
    "ownerWallet": $(cat owner.json),
    "endpoint": "https://devnet.solana.com",
    "signerPrivateKey": "$priv_key"
}
EOF
