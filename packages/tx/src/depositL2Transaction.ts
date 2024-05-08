import { RLP } from '@ethereumjs/rlp'
import {
  Address,
  BIGINT_0,
  BIGINT_27,
  BigIntLike,
  MAX_INTEGER,
  bigIntToHex,
  bigIntToUnpaddedBytes,
  bytesToBigInt,
  bytesToHex,
  equalsBytes,
  toBytes,
  validateNoLeadingZeroes,
} from '@ethereumjs/util'

import { BaseTransaction } from './baseTransaction.js'
import * as EIP1559 from './capabilities/eip1559.js'
import * as EIP2718 from './capabilities/eip2718.js'
import * as EIP2930 from './capabilities/eip2930.js'
import * as Legacy from './capabilities/legacy.js'
import { TransactionType } from './types.js'
import { AccessLists, txTypeBytes } from './util.js'

import type {
  AccessList,
  AccessListBytes,
  TxData as AllTypesTxData,
  TxValuesArray as AllTypesTxValuesArray,
  JsonTx,
  TxOptions,
} from './types.js'
import type { Common } from '@ethereumjs/common'
import { access } from 'fs'

type TxData = AllTypesTxData[TransactionType.DepositL2]
type TxValuesArray = AllTypesTxValuesArray[TransactionType.DepositL2]

/**
 * Typed transaction with a new gas fee market mechanism
 *
 * - TransactionType: 0x7e (126)
 * - OPSTACK: [Deposit Transaction](https://specs.optimism.io/protocol/deposits.html#the-deposited-transaction-type)
 */
export class DepositL2Transaction extends BaseTransaction<TransactionType.DepositL2> {
  // implements DepositL2CompatibleTx<TransactionType.DepositL2>

  public readonly from: Address | undefined;
  public readonly sourceHash: Uint8Array;
  public readonly isSystemTx: bigint;
  public readonly mint: bigint;
  public readonly chainId: bigint;
  public readonly accessList: AccessListBytes;
  public readonly AccessListJSON: AccessList;
  public readonly maxPriorityFeePerGas: bigint;
  public readonly maxFeePerGas: bigint;


  public readonly common: Common
  /**
   * Instantiate a transaction from a data dictionary.
   *
   * Format: { sourceHash, from, to, mint, value, gas, isSystemTx, data}
   *
   */
  public static fromTxData(txData: TxData, opts: TxOptions = {}) {
    return new DepositL2Transaction(txData, opts)
  }

  /**
   * Instantiate a transaction from the serialized tx.
   *
   * Format: `0x7e || rlp([sourceHash, from, to, mint, value, gas, isSystemTx, data])`
   */
  public static fromSerializedTx(serialized: Uint8Array, opts: TxOptions = {}) {
    if (
      equalsBytes(serialized.subarray(0, 1), txTypeBytes(TransactionType.DepositL2)) ===
      false
    ) {
      throw new Error(
        `Invalid serialized tx input: not an DepositL2 transaction (wrong tx type, expected: ${
          TransactionType.DepositL2
        }, received: ${bytesToHex(serialized.subarray(0, 1))}`
      )
    }

    const values = RLP.decode(serialized.subarray(1))

    if (!Array.isArray(values)) {
      throw new Error('Invalid serialized tx input: must be array')
    }

    return DepositL2Transaction.fromValuesArray(values as TxValuesArray, opts)
  }

  /**
   * Create a transaction from a values array.
   *
   * Format: `[sourceHash, from, to, mint, value, gas, isSystemTx, data,
   * accessList?, signatureYParity?, signatureR?, signatureS?]`
   */
  public static fromValuesArray(values: TxValuesArray, opts: TxOptions = {}) {
    if (
      values.length < 8
    ) {
      throw new Error(
        'Invalid DepositL2 transaction values array length.'
      )
    }

    const [
      sourceHash,
      from,
      to,
      mint,
      value,
      gasLimit,
      isSystemTx,
      data,
    ] = values

    validateNoLeadingZeroes({ mint, isSystemTx, gasLimit, value })

    return new DepositL2Transaction(
      {
        sourceHash,
        from,
        gasLimit,
        to,
        value,
        data,
        mint,
      },
      opts
    )
  }

  /**
   * This constructor takes the values, validates them, assigns them and freezes the object.
   *
   * It is not recommended to use this constructor directly. Instead use
   * the static factory methods to assist in creating a Transaction object from
   * varying data types.
   */
  public constructor(txData: TxData, opts: TxOptions = {}) {
    super({ ...txData, type: TransactionType.DepositL2 }, opts)

    this.common = this._getCommon(opts.common)

    this.chainId = this.common.chainId();
    // Populate the access list fields
    const accessListData = AccessLists.getAccessListData( [])
    this.accessList = accessListData.accessList
    this.AccessListJSON = accessListData.AccessListJSON
    // Verify the access list format.
    AccessLists.verifyAccessList(this.accessList)

    this.maxFeePerGas = bytesToBigInt(toBytes(0));
    this.maxPriorityFeePerGas = bytesToBigInt(toBytes(0));

    if (!this.common.isActivatedEIP(1559)) {
      throw new Error('EIP-1559 not enabled on Common')
    }
    this.activeCapabilities = this.activeCapabilities.concat([1559, 2718, 2930])



    BaseTransaction._validateNotArray(txData)


    Legacy.validateHighS(this);
    this.sourceHash = toBytes(txData.sourceHash);
    this.from = txData.from ? new Address(toBytes(txData.from)) : new Address(new Uint8Array(20));
    this.isSystemTx = txData.isSystemTx ? bytesToBigInt(toBytes(txData.isSystemTx)) : BigInt(0);
    this.mint = bytesToBigInt(toBytes(txData.mint));
    const freeze = opts?.freeze ?? true
    if (freeze) {
      Object.freeze(this)
    }
  }

  /**
   * The amount of gas paid for the data in this tx
   */
  getDataFee(): bigint {
    return EIP2930.getDataFee(this)
  }

  /**
   * Returns the minimum of calculated priority fee (from maxFeePerGas and baseFee) and maxPriorityFeePerGas
   * @param baseFee Base fee retrieved from block
   */
  getEffectivePriorityFee(baseFee: bigint): bigint {
    return EIP1559.getEffectivePriorityFee(this, baseFee)
  }

  /**
   * The up front amount that an account must have for this transaction to be valid
   * @param baseFee The base fee of the block (will be set to 0 if not provided)
   */
  getUpfrontCost(baseFee: bigint = BIGINT_0): bigint {
    return EIP1559.getUpfrontCost(this, baseFee)
  }

  /**
   * Returns a Uint8Array Array of the raw Bytes of the EIP-1559 transaction, in order.
   *
   * Format: `[bytes32 sourceHash: the source-hash, uniquely identifies the origin of the deposit.
address from: The address of the sender account.
address to: The address of the recipient account, or the null (zero-length) address if the deposited transaction is a contract creation.
uint256 mint: The ETH value to mint on L2.
uint256 value: The ETH value to send to the recipient account.
uint64 gas: The gas limit for the L2 transaction.
bool isSystemTx: If true, the transaction does not interact with the L2 block gas pool.
Note: boolean is disabled (enforced to be false) starting from the Regolith upgrade.
bytes data: The calldata.
signatureYParity, signatureR, signatureS]`
   *
   * Use {@link FeeMarketEIP1559Transaction.serialize} to add a transaction to a block
   * with {@link Block.fromValuesArray}.
   *
   * For an unsigned tx this method uses the empty Bytes values for the
   * signature parameters `v`, `r` and `s` for encoding. For an EIP-155 compliant
   * representation for external signing use {@link FeeMarketEIP1559Transaction.getMessageToSign}.
   */
  raw(): TxValuesArray {
    return [
      this.sourceHash,
      this.from ? this.from.bytes : new Uint8Array(0),
      this.to ? this.to.bytes : new Uint8Array(0),
      bigIntToUnpaddedBytes(this.mint),
      bigIntToUnpaddedBytes(this.value),
      bigIntToUnpaddedBytes(this.gasLimit),
      bigIntToUnpaddedBytes(this.isSystemTx),
      this.data,

    ]
  }

  /**
   * Returns the serialized encoding of the EIP-1559 transaction.
   *
   * Format: `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data,
   * accessList, signatureYParity, signatureR, signatureS])`
   *
   * Note that in contrast to the legacy tx serialization format this is not
   * valid RLP any more due to the raw tx type preceding and concatenated to
   * the RLP encoding of the values.
   */
  serialize(): Uint8Array {
    return EIP2718.serialize(this)
  }

  /**
   * Returns the raw serialized unsigned tx, which can be used
   * to sign the transaction (e.g. for sending to a hardware wallet).
   *
   * Note: in contrast to the legacy tx the raw message format is already
   * serialized and doesn't need to be RLP encoded any more.
   *
   * ```javascript
   * const serializedMessage = tx.getMessageToSign() // use this for the HW wallet input
   * ```
   */
  getMessageToSign(): Uint8Array {
    return EIP2718.serialize(this, this.raw().slice(0, 9))
  }

  /**
   * Returns the hashed serialized unsigned tx, which can be used
   * to sign the transaction (e.g. for sending to a hardware wallet).
   *
   * Note: in contrast to the legacy tx the raw message format is already
   * serialized and doesn't need to be RLP encoded any more.
   */
  getHashedMessageToSign(): Uint8Array {
    return EIP2718.getHashedMessageToSign(this)
  }

  /**
   * Computes a sha3-256 hash of the serialized tx.
   *
   * This method can only be used for signed txs (it throws otherwise).
   * Use {@link FeeMarketEIP1559Transaction.getMessageToSign} to get a tx hash for the purpose of signing.
   */
  public hash(): Uint8Array {
    return Legacy.hash(this)
  }

  /**
   * Computes a sha3-256 hash which can be used to verify the signature
   */
  public getMessageToVerifySignature(): Uint8Array {
    return this.getHashedMessageToSign()
  }

  /**
   * Returns the public key of the sender
   */
  public getSenderPublicKey(): Uint8Array {
    return Legacy.getSenderPublicKey(this)
  }

  addSignature(
    v: bigint,
    r: Uint8Array | bigint,
    s: Uint8Array | bigint,
    convertV: boolean = false
  ): DepositL2Transaction {
    r = toBytes(r)
    s = toBytes(s)
    const opts = { ...this.txOptions, common: this.common }

    return DepositL2Transaction.fromTxData(
      {
        chainId: this.chainId,
        nonce: this.nonce,
        maxPriorityFeePerGas: this.maxPriorityFeePerGas,
        maxFeePerGas: this.maxFeePerGas,
        gasLimit: this.gasLimit,
        to: this.to,
        value: this.value,
        data: this.data,
        accessList: this.accessList,
        v: convertV ? v - BIGINT_27 : v, // This looks extremely hacky: @ethereumjs/util actually adds 27 to the value, the recovery bit is either 0 or 1.
        r: bytesToBigInt(r),
        s: bytesToBigInt(s),
      },
      opts
    )
  }

  /**
   * Returns an object with the JSON representation of the transaction
   */
  toJSON(): JsonTx {
    const accessListJSON = AccessLists.getAccessListJSON(this.accessList)
    const baseJson = super.toJSON()

    return {
      ...baseJson,
      chainId: bigIntToHex(this.chainId),
      maxPriorityFeePerGas: bigIntToHex(this.maxPriorityFeePerGas),
      maxFeePerGas: bigIntToHex(this.maxFeePerGas),
      accessList: accessListJSON,
    }
  }

  /**
   * Return a compact error string representation of the object
   */
  public errorStr() {
    let errorStr = this._getSharedErrorPostfix()
    errorStr += ` maxFeePerGas=${this.maxFeePerGas} maxPriorityFeePerGas=${this.maxPriorityFeePerGas}`
    return errorStr
  }

  /**
   * Internal helper function to create an annotated error message
   *
   * @param msg Base error message
   * @hidden
   */
  protected _errorMsg(msg: string) {
    return Legacy.errorMsg(this, msg)
  }
}
